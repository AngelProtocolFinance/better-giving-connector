import { createHash } from "node:crypto";
import { mcp } from "@better-auth/mcp";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { applySetCookies } from "better-auth/cookies";
import { Kysely } from "kysely";
import type { Connections, Db } from "../db";
import type { DeploymentClient } from "../deployment";
import type { Origin } from "../deployment/origin";
import type { Env } from "../env";
import { log } from "../log";
import type { Secret } from "../secret";
import { connectionPlugin } from "./connection-plugin";
import { libsqlDialect } from "./libsql-dialect";
import { isAllowedRedirectUri } from "./redirect-uris";
import {
	ACCESS_TOKEN_EXPIRES_IN,
	RATE_LIMIT_RETENTION,
	REFRESH_TOKEN_EXPIRES_IN,
	SESSION_EXPIRES_IN,
} from "./token-lifetimes";

export type AuthDeps = {
	db: Db;
	connections: Connections;
	env: Env;
	client: Pick<DeploymentClient, "disconnect">;
};

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
	 * connection row, then the authorize request resumed for that user. The
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
	 * Ends a connection: asks its deployment to revoke the key, then deletes
	 * its row, then its user with every session, token and consent. The
	 * revoke is best effort; its failure is logged by name and the drop goes
	 * on. A failure part-way through the deletes leaves a user without a row:
	 * /mcp answers its tokens "reconnect", and the next sweep finishes the drop.
	 */
	dropConnection(userId: string): Promise<void>;
	/**
	 * Drops connections no chat app can use any more, as `dropConnection`
	 * does but with the batch's revokes bounded in time (a deployment not
	 * reached by then is never told): a user over an hour old with no
	 * connection row, whose session has ended, or with no unexpired, unrevoked
	 * refresh token and no unexpired access token. Registered clients stay: a
	 * chat app keeps its client and reuses it for its next connection. At most 500 per call; `more` says the batch
	 * was full, so the next call may find the rest. Also deletes rate-limit
	 * rows whose last request is older than `RATE_LIMIT_RETENTION`, and
	 * verification rows whose `expiresAt` has passed.
	 */
	sweep(): Promise<{ connections: number; more: boolean }>;
}

const SWEEP_BATCH = 500;
const SWEEP_REVOKES_AT_ONCE = 50;
// two waves of DISCONNECT_TIMEOUT_MS (src/deployment/index.ts)
const SWEEP_REVOKE_BUDGET_MS = 10_000;
const HOUR = 60 * 60 * 1000;

export class LoginRequestRefused extends Error {
	override name = "LoginRequestRefused";
	constructor() {
		super("the signed authorization request is invalid or has expired");
	}
}

const CONSENT_PAGE = "/connect/consent";

export function buildAuth(
	{ db, env }: Pick<AuthDeps, "db" | "env">,
	authDb: AuthDb,
	revoked: (token: string) => Promise<void>,
) {
	const resource = `${env.PUBLIC_URL}/mcp`;
	const provider = mcp({
		resource,
		loginPage: "/connect",
		consentPage: CONSENT_PAGE,
		allowDynamicClientRegistration: true,
		allowUnauthenticatedClientRegistration: true,
		disableJwtPlugin: true,
		// the only scope offered, so whatever a chat app picks from
		// `scopes_supported` (or leaves to the default) yields a refresh token;
		// no `openid`, as this server never issues an id_token
		scopes: ["offline_access"],
		validateRedirectUri: (uri, _registered, matchesRegistered) =>
			matchesRegistered && isAllowedRedirectUri(uri),
		// a connection lasts while the chat app refreshes at least this often,
		// up to the session's year. The privacy page states these two lifetimes.
		accessTokenExpiresIn: ACCESS_TOKEN_EXPIRES_IN,
		refreshTokenExpiresIn: REFRESH_TOKEN_EXPIRES_IN,
		// oauth-provider's refresh grant never checks the session its tokens are
		// bound to, and /mcp refuses them once it ends; createUserTokens calls
		// this before createRefreshToken revokes the old token or any token is
		// written, so the chat app gets the invalid_grant that sends it to sign
		// in again with its refresh token untouched
		customTokenResponseFields: async ({ grantType, user }) => {
			const ended =
				grantType === "refresh_token" &&
				user &&
				!(await hasLiveSession(authDb, user.id, new Date()));
			if (ended)
				throw new APIError("BAD_REQUEST", {
					error: "invalid_grant",
					error_description: "the connection has ended",
				});
			return {};
		},
		// per address; both chat apps call these from shared server addresses
		rateLimit: {
			register: { window: 60, max: 60 },
			token: { window: 60, max: 600 },
			// a 429 here leaves the connection, and its key, live
			revoke: { window: 60, max: 600 },
		},
	});
	return betterAuth({
		baseURL: env.PUBLIC_URL,
		secret: env.BETTER_AUTH_SECRET,
		trustedOrigins: [env.PUBLIC_URL],
		database: { dialect: libsqlDialect(db), type: "sqlite" },
		telemetry: { enabled: false },
		// a message can carry SQL or a token; the level, or the name of the
		// error passed with it, is all that reaches a log line
		logger: {
			log: (level, _message, ...args) =>
				log({
					kind: "error",
					where: "auth",
					errorName: args.find((a) => a instanceof Error)?.name ?? level,
				}),
		},
		// an unexpected error rejects `handler` for the app's onError to log,
		// instead of better-call writing it, message and all, to the console
		onAPIError: { throw: true },
		// This session never reaches a browser; it caps the connection at a
		// year. Once it ends, /mcp refuses the connection's access tokens and the
		// refresh grant answers invalid_grant, so the chat app signs in again.
		session: { expiresIn: SESSION_EXPIRES_IN },
		rateLimit: { enabled: true, storage: "database" },
		plugins: [
			provider,
			connectionPlugin({ provider: provider.options, resource, revoked }),
		],
	});
}

export function createAuth(deps: AuthDeps): AuthFacade {
	const authDb = authTables(deps.db);
	const auth = buildAuth(deps, authDb, endIfRevokedByChatApp);
	const base = deps.env.PUBLIC_URL;

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

	// Best effort: a deployment that can't be told keeps the key live there,
	// and the drop goes on regardless.
	async function revokeKey(userId: string) {
		try {
			const connection = await deps.connections.get(userId);
			if (connection) await deps.client.disconnect(connection);
		} catch (error) {
			log({
				kind: "error",
				where: "disconnect",
				errorName: error instanceof Error ? error.name : "unknown",
			});
		}
	}

	// Side by side, and none started past the budget, so a batch of hung
	// deployments can't outrun the cron's SWEEP_BUDGET_MS (src/cron.ts); one
	// still in flight then runs out on the client's own timeout.
	async function revokeKeys(userIds: readonly string[]) {
		const queue = [...userIds];
		let expired = false;
		const worker = async () => {
			for (
				let id = queue.shift();
				id !== undefined && !expired;
				id = queue.shift()
			) {
				await revokeKey(id);
			}
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const budget = new Promise<void>((resolve) => {
			timer = setTimeout(() => {
				expired = true;
				resolve();
			}, SWEEP_REVOKE_BUDGET_MS);
		});
		const workers = Array.from({ length: SWEEP_REVOKES_AT_ONCE }, worker);
		await Promise.race([Promise.all(workers), budget]);
		clearTimeout(timer);
	}

	// A chat app revoking its refresh token is done with the connection once no
	// other refresh token is live. A revoked row alone doesn't prove this
	// revoke marked it: another client revoking a token rotation already
	// revoked finds that row, and only the live-token check keeps the
	// connection. A failure here is logged, not thrown, as the revoke has
	// already taken effect; the sweep finishes the drop.
	async function endIfRevokedByChatApp(token: string) {
		try {
			const row = await authDb
				.selectFrom("oauthRefreshToken")
				.select(["userId", "revoked"])
				.where("token", "=", storedToken(token))
				.executeTakeFirst();
			if (!row?.revoked || !row.userId) return;
			if (await hasLiveRefreshToken(authDb, row.userId, new Date())) return;
			await dropConnection(row.userId);
		} catch (error) {
			log({
				kind: "error",
				where: "auth",
				errorName: error instanceof Error ? error.name : "unknown",
			});
		}
	}

	async function dropConnection(userId: string) {
		await revokeKey(userId);
		await deleteConnection(userId);
	}

	async function deleteConnection(userId: string) {
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
		async sweep() {
			const dead = await deadUsers(authDb, new Date());
			await revokeKeys(dead);
			let dropped = 0;
			// One user whose drop throws must not stop the rest: deadUsers orders
			// by age, so that user would lead every batch and jam the sweep for good.
			for (const userId of dead) {
				try {
					await deleteConnection(userId);
					dropped++;
				} catch (error) {
					log({
						kind: "error",
						where: "sweep",
						errorName: error instanceof Error ? error.name : "unknown",
					});
				}
			}
			await deleteStaleRows(authDb, new Date());
			return { connections: dropped, more: dead.length === SWEEP_BATCH };
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
	user: { id: string; createdAt: IsoDate };
	session: { userId: string; expiresAt: IsoDate };
	// the data lane's table (migrations/0002_connection.sql)
	connection: { user_id: string };
	oauthRefreshToken: TokenRow & { token: string };
	oauthAccessToken: TokenRow;
	rateLimit: { lastRequest: number };
	verification: { expiresAt: IsoDate };
};

type AuthDb = Kysely<AuthTables>;

const authTables = (db: Db): AuthDb =>
	new Kysely<AuthTables>({ dialect: libsqlDialect(db) });

// oauth-provider's default `storeTokens: "hashed"`
const storedToken = (token: string) =>
	createHash("sha256").update(token).digest("base64url");

async function hasLiveRefreshToken(db: AuthDb, userId: string, now: Date) {
	const live = await db
		.selectFrom("oauthRefreshToken")
		.select("id")
		.where("userId", "=", userId)
		.where("revoked", "is", null)
		.where("expiresAt", ">", now.toISOString())
		.executeTakeFirst();
	return live !== undefined;
}

async function hasLiveSession(db: AuthDb, userId: string, now: Date) {
	const live = await db
		.selectFrom("session")
		.select("userId")
		.where("userId", "=", userId)
		.where("expiresAt", ">", now.toISOString())
		.executeTakeFirst();
	return live !== undefined;
}

// Past RATE_LIMIT_RETENTION (token-lifetimes.ts), which the privacy page
// states. The longest window is 60 seconds, so a row this old is idle.
// An authorization code is a verification row; exchanging it deletes that
// row, and one that expires unused stays until this delete.
async function deleteStaleRows(db: AuthDb, now: Date) {
	await db
		.deleteFrom("rateLimit")
		.where("lastRequest", "<", now.getTime() - RATE_LIMIT_RETENTION * 1000)
		.execute();
	await db
		.deleteFrom("verification")
		.where("expiresAt", "<", now.toISOString())
		.execute();
}

async function deadUsers(db: AuthDb, now: Date) {
	const at = now.toISOString();
	const rows = await db
		.selectFrom("user")
		.select("user.id")
		// younger than this may be mid-sign-in, its code not yet exchanged
		.where("user.createdAt", "<", new Date(now.getTime() - HOUR).toISOString())
		.where(({ not, exists, selectFrom, or }) => {
			const live = (table: "oauthRefreshToken" | "oauthAccessToken") =>
				exists(
					selectFrom(table)
						.select("id")
						.whereRef("userId", "=", "user.id")
						.where("revoked", "is", null)
						.where("expiresAt", ">", at),
				);
			const liveSession = exists(
				selectFrom("session")
					.select("userId")
					.whereRef("userId", "=", "user.id")
					.where("expiresAt", ">", at),
			);
			const hasRow = exists(
				selectFrom("connection")
					.select("user_id")
					.whereRef("user_id", "=", "user.id"),
			);
			return or([
				not(hasRow),
				not(liveSession),
				not(live("oauthRefreshToken")).and(not(live("oauthAccessToken"))),
			]);
		})
		.orderBy("user.createdAt")
		.limit(SWEEP_BATCH)
		.execute();
	return rows.map((r) => r.id);
}
