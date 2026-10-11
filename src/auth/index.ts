import { mcp } from "@better-auth/mcp";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { applySetCookies } from "better-auth/cookies";
import { Kysely } from "kysely";
import type { Connections, Db } from "../db";
import type { Origin } from "../deployment/origin";
import type { Env } from "../env";
import type { Secret } from "../secret";
import { connectionPlugin } from "./connection-plugin";
import { libsqlDialect } from "./libsql-dialect";
import { isAllowedRedirectUri } from "./redirect-uris";

export type AuthDeps = { db: Db; connections: Connections; env: Env };

export interface AuthFacade {
	handler(req: Request): Promise<Response>;
	/**
	 * Reads the authorization request better-auth signed into the `/connect`
	 * URL it redirected to. Null when the signature fails or has expired
	 * (10 minutes after the chat app opened the authorize URL).
	 */
	readLoginRequest(url: URL): Promise<{ oauthQuery: string } | null>;
	/**
	 * Makes the connection the deployment just allowed: a new user, its
	 * connection row, its client marked used so `sweep` keeps it, then the
	 * authorize request resumed for that user. The
	 * 302 carries the code to the chat app's redirect_uri and no cookie; a
	 * 302 without a code (better-auth's error redirect) or a throw past the
	 * user's creation drops the connection first. Throws `LoginRequestRefused`
	 * before creating anything when `oauthQuery` no longer verifies.
	 */
	completeConnection(c: {
		oauthQuery: string;
		origin: Origin;
		orgName: string;
		key: Secret;
	}): Promise<Response>;
	/**
	 * The operator's Cancel: a 302 to the chat app's redirect_uri carrying
	 * `error=access_denied`, its `state` and `iss`. Creates no user, row or
	 * session. Throws `LoginRequestRefused` when `oauthQuery` no longer
	 * verifies.
	 */
	denyConnection(oauthQuery: string): Promise<Response>;
	/**
	 * The user an `/mcp` request's access token was issued to, or null when
	 * the token is missing, malformed, unknown, expired, revoked, issued for
	 * another resource, or DPoP-bound without a matching proof.
	 */
	authenticateMcp(req: Request): Promise<{ userId: string } | null>;
	/**
	 * Ends a connection: its row first, then its user with every session,
	 * token and consent. A failure part-way leaves tokens without a row,
	 * which /mcp already answers as "reconnect".
	 */
	dropConnection(userId: string): Promise<void>;
	/**
	 * Drops connections no chat app can use any more (a user over an hour old
	 * with no unexpired, unrevoked refresh token and no unexpired access
	 * token), each through `dropConnection`, and deletes registered clients
	 * over a day old that never completed a connection and hold no token. A
	 * chat app may keep a used client's id for good. At most 500 of each per
	 * call; the next call takes the rest. Answers counts only.
	 */
	sweep(now?: Date): Promise<{ connections: number; clients: number }>;
}

const SWEEP_BATCH = 500;
const HOUR = 60 * 60 * 1000;

export class LoginRequestRefused extends Error {
	override name = "LoginRequestRefused";
	constructor() {
		super("the signed authorization request is invalid or has expired");
	}
}

const CONSENT_PAGE = "/connect/consent";

export function buildAuth({ db, env }: Pick<AuthDeps, "db" | "env">) {
	const resource = `${env.PUBLIC_URL}/mcp`;
	const provider = mcp({
		resource,
		loginPage: "/connect",
		consentPage: CONSENT_PAGE,
		allowDynamicClientRegistration: true,
		allowUnauthenticatedClientRegistration: true,
		disableJwtPlugin: true,
		validateRedirectUri: (uri, _registered, matchesRegistered) =>
			matchesRegistered && isAllowedRedirectUri(uri),
		// a connection lasts while the chat app refreshes at least this often,
		// up to the session's year
		refreshTokenExpiresIn: 60 * 60 * 24 * 90,
		// per address; both chat apps call these from shared server addresses
		rateLimit: {
			register: { window: 60, max: 60 },
			token: { window: 60, max: 600 },
		},
	});
	return betterAuth({
		baseURL: env.PUBLIC_URL,
		secret: env.BETTER_AUTH_SECRET,
		trustedOrigins: [env.PUBLIC_URL],
		database: { dialect: libsqlDialect(db), type: "sqlite" },
		telemetry: { enabled: false },
		// oauth-provider refuses every access token, refreshed ones included,
		// once the session it was issued under expires. This session never
		// reaches a browser, so it caps the connection: at most a year, then the
		// chat app signs in again.
		session: { expiresIn: 60 * 60 * 24 * 365 },
		rateLimit: { enabled: true, storage: "database" },
		plugins: [
			provider,
			connectionPlugin({ provider: provider.options, resource }),
		],
	});
}

export function createAuth(deps: AuthDeps): AuthFacade {
	const auth = buildAuth(deps);
	const base = deps.env.PUBLIC_URL;

	const authDb = new Kysely<AuthTables>({
		dialect: libsqlDialect(deps.db),
	});

	const verifies = async (oauthQuery: string) =>
		verifyOAuthQueryParams(oauthQuery, (await auth.$context).secret);

	// The browser never receives this session's cookie, so the next authorize
	// from the same browser lands on /connect again rather than reusing this
	// user. Returns where better-auth sends the browser next.
	async function signInAndResume(userId: string, oauthQuery: string) {
		const signedIn = await auth.api.signInConnection({
			body: { userId, oauth_query: oauthQuery },
			// oauth-provider's authorize needs a request; a bare one also keeps the
			// operator's IP and user agent off the session row
			request: new Request(`${base}/api/auth/connection/sign-in`, {
				method: "POST",
			}),
			asResponse: true,
		});
		const next = await redirectUrl(signedIn);
		if (next.pathname !== CONSENT_PAGE) return next;
		// The deployment's Allow is the operator's consent; record it the way
		// oauth-provider's own consent endpoint does.
		const headers = new Headers();
		applySetCookies(headers, signedIn.headers.getSetCookie());
		const consented = await auth.api.oauth2Consent({
			body: { accept: true, oauth_query: next.search.slice(1) },
			headers,
			request: new Request(`${base}/api/auth/oauth2/consent`, {
				method: "POST",
				headers,
			}),
			asResponse: true,
		});
		return redirectUrl(consented);
	}

	// oauth-provider answers a redirect as a 302, or as `{ redirect, url }`
	// JSON when it reads the request as a fetch.
	async function redirectUrl(res: Response): Promise<URL> {
		const location =
			res.headers.get("location") ??
			((await res.json()) as { url?: string } | null)?.url;
		if (!location) throw new Error(`better-auth answered ${res.status}`);
		return new URL(location, base);
	}

	async function dropConnection(userId: string) {
		await deps.connections.delete(userId);
		const { adapter, internalAdapter } = await auth.$context;
		const byUser = [{ field: "userId", value: userId }];
		// explicit, not left to FK cascades: foreign_keys is a per-connection
		// libSQL setting. Access tokens first, as they reference refresh rows.
		for (const model of [
			"oauthAccessToken",
			"oauthRefreshToken",
			"oauthConsent",
		]) {
			await adapter.deleteMany({ model, where: byUser });
		}
		await internalAdapter.deleteUser(userId);
	}

	return {
		handler: (req) => auth.handler(req),
		authenticateMcp: (req) =>
			auth.api.verifyMcpAccessToken({
				body: {
					authorization: req.headers.get("authorization") ?? undefined,
					dpop: req.headers.get("dpop") ?? undefined,
					method: req.method,
					url: req.url,
				},
			}),
		async readLoginRequest(url) {
			const oauthQuery = url.search.slice(1);
			return (await verifies(oauthQuery)) ? { oauthQuery } : null;
		},
		dropConnection,
		async sweep(now = new Date()) {
			const clients = await deleteUnusedClients(authDb, now);
			const dead = await deadUsers(authDb, now);
			for (const userId of dead) await dropConnection(userId);
			return { connections: dead.length, clients };
		},
		async denyConnection(oauthQuery) {
			if (!(await verifies(oauthQuery))) throw new LoginRequestRefused();
			const denied = await auth.api.denyConnection({
				body: { oauth_query: oauthQuery },
			});
			return new Response(null, {
				status: 302,
				headers: { location: denied.url },
			});
		},
		async completeConnection(c) {
			if (!(await verifies(c.oauthQuery))) throw new LoginRequestRefused();
			const { internalAdapter } = await auth.$context;
			const user = await internalAdapter.createUser(
				{
					name: "Better Giving connection",
					email: `${crypto.randomUUID()}@connection.invalid`,
					emailVerified: false,
				},
				{ method: "connection" },
			);
			// no row holding a deployment key outlives a connection that never
			// reached the chat app
			let next: URL;
			try {
				await deps.connections.insert({
					userId: user.id,
					origin: c.origin,
					orgName: c.orgName,
					key: c.key,
				});
				await markClientUsed(authDb, c.oauthQuery);
				next = await signInAndResume(user.id, c.oauthQuery);
			} catch (error) {
				await dropConnection(user.id);
				throw error;
			}
			if (!next.searchParams.has("code")) await dropConnection(user.id);
			return new Response(null, {
				status: 302,
				headers: { location: next.toString() },
			});
		},
	};
}

// better-auth stores dates on SQLite as ISO-8601 text, which orders as time
type IsoDate = string;
type TokenRow = {
	id: string;
	clientId: string;
	userId: string | null;
	expiresAt: IsoDate;
	revoked: IsoDate | null;
};
type AuthTables = {
	used_client: { client_id: string };
	user: { id: string; createdAt: IsoDate };
	oauthClient: { clientId: string; createdAt: IsoDate | null };
	oauthClientResource: { clientId: string };
	oauthRefreshToken: TokenRow;
	oauthAccessToken: TokenRow;
};

async function deadUsers(db: Kysely<AuthTables>, now: Date) {
	const at = now.toISOString();
	const rows = await db
		.selectFrom("user")
		.select("user.id")
		// younger than this may be mid-sign-in, its code not yet exchanged
		.where("user.createdAt", "<", new Date(now.getTime() - HOUR).toISOString())
		.where(({ not, exists, selectFrom }) => {
			const live = (table: "oauthRefreshToken" | "oauthAccessToken") =>
				exists(
					selectFrom(table)
						.select("id")
						.whereRef("userId", "=", "user.id")
						.where("revoked", "is", null)
						.where("expiresAt", ">", at),
				);
			return not(live("oauthRefreshToken")).and(not(live("oauthAccessToken")));
		})
		.orderBy("user.createdAt")
		.limit(SWEEP_BATCH)
		.execute();
	return rows.map((r) => r.id);
}

// Open registration lets anyone add a client; one a day old that never
// completed a connection and holds no token is junk. The checks and the
// delete are one statement, so a token issued meanwhile keeps its client.
async function deleteUnusedClients(db: Kysely<AuthTables>, now: Date) {
	const unused = db
		.selectFrom("oauthClient")
		.select("oauthClient.clientId")
		.where(
			"oauthClient.createdAt",
			"<",
			new Date(now.getTime() - 24 * HOUR).toISOString(),
		)
		.where(({ not, exists, selectFrom }) => {
			const any = (table: "oauthRefreshToken" | "oauthAccessToken") =>
				exists(
					selectFrom(table)
						.select("clientId")
						.whereRef("clientId", "=", "oauthClient.clientId"),
				);
			const used = exists(
				selectFrom("used_client")
					.select("client_id")
					.whereRef("client_id", "=", "oauthClient.clientId"),
			);
			return not(used)
				.and(not(any("oauthRefreshToken")))
				.and(not(any("oauthAccessToken")));
		})
		.limit(SWEEP_BATCH);
	const deleted = (
		await db
			.deleteFrom("oauthClient")
			.where("clientId", "in", unused)
			.returning("clientId")
			.execute()
	).map((r) => r.clientId);
	if (deleted.length > 0)
		await db
			.deleteFrom("oauthClientResource")
			.where("clientId", "in", deleted)
			.execute();
	return deleted.length;
}

async function markClientUsed(db: Kysely<AuthTables>, oauthQuery: string) {
	const clientId = new URLSearchParams(oauthQuery).get("client_id");
	if (!clientId) throw new Error("the authorization request has no client_id");
	await db
		.insertInto("used_client")
		.values({ client_id: clientId })
		.onConflict((oc) => oc.doNothing())
		.execute();
}
