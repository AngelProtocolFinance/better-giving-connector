import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	type FakeDeployment,
	fakeDeployment,
	hang,
} from "../../test/fake-deployment";
import { BASE, env, INITIALIZE, mcpPost } from "../../test/harness";
import {
	type Authorization,
	type AuthorizationOptions,
	authorization,
	type Call,
	CHATGPT_CALLBACK_REDIRECT_URI,
	CHATGPT_REDIRECT_URI,
	discover,
	type Endpoints,
	exchangeCode,
	openAuthorization,
	REDIRECT_URI,
	redirectTarget,
	refresh,
	registerClient,
	type Tokens,
} from "../../test/oauth";
import {
	advance,
	connectionRows,
	countRows,
	DAY,
	failingDb,
	freshDb,
	LIVE_CONNECTION_ROWS,
	MINUTE,
	NO_CONNECTION_ROWS,
	StoreDown,
	seedDeadUsers,
} from "../../test/support";
import { type Connections, connections, type Db } from "../db";
import {
	type DeploymentClient,
	deploymentClient,
	KeyRefused,
} from "../deployment";
import type { Origin } from "../deployment/origin";
import { Secret } from "../secret";
import { type AuthFacade, createAuth, LoginRequestRefused } from "./index";
import { RATE_LIMIT_RETENTION } from "./token-lifetimes";

let db: Db;
let store: Connections;
let auth: AuthFacade;
let call: Call;
let ep: Endpoints;
let deployment: FakeDeployment;
let deploymentApi: DeploymentClient;

beforeEach(async () => {
	db = await freshDb();
	store = connections(db, env.CONNECTION_KEY_SECRET);
	deployment = fakeDeployment();
	deploymentApi = deploymentClient({ fetch: deployment.fetch });
	auth = createAuth({ db, connections: store, env, client: deploymentApi });
	call = (req) => auth.handler(req);
	ep = await discover(call, BASE);
	return () => db.close();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// Silences the console; returns a reader of every call as [method, ...args].
function captureConsole() {
	const methods = ["log", "info", "warn", "error", "debug"] as const;
	const spies = methods.map(
		(m) => [m, vi.spyOn(console, m).mockImplementation(() => {})] as const,
	);
	return () =>
		spies.flatMap(([m, spy]) => spy.mock.calls.map((args) => [m, ...args]));
}

test("serves metadata naming /mcp as the resource and an open registration endpoint", async () => {
	const pathInserted = await call(
		new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`),
	);

	expect(await pathInserted.json()).toMatchObject({ resource: `${BASE}/mcp` });
	expect(ep).toEqual({
		resource: `${BASE}/mcp`,
		authorization: `${BASE}/api/auth/oauth2/authorize`,
		token: `${BASE}/api/auth/oauth2/token`,
		registration: `${BASE}/api/auth/oauth2/register`,
		scopes: expect.any(Array),
	});
});

test("authorization-server metadata offers offline_access as its only scope and no OpenID Connect", async () => {
	const as = await call(
		new Request(`${BASE}/.well-known/oauth-authorization-server/api/auth`),
	);
	const openid = await call(
		new Request(`${BASE}/api/auth/.well-known/openid-configuration`),
	);

	expect(ep.scopes).toEqual(["offline_access"]);
	expect(await as.json()).not.toHaveProperty("userinfo_endpoint");
	expect(openid.status).toBe(404);
});

test("a public client registers itself with no session", async () => {
	const client = await registerClient(call, ep);

	expect(client).toMatchObject({
		token_endpoint_auth_method: "none",
		redirect_uris: [REDIRECT_URI],
	});
	expect(client.client_id).toMatch(/\S/);
	expect(client.client_secret).toBeUndefined();
});

function registration(redirectUri: string): Request {
	return new Request(ep.registration, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: "none",
			// oauth-provider refuses http redirects for web clients on its own;
			// native leaves a loopback refusal to the allowlist
			application_type: "native",
		}),
	});
}

test.each([REDIRECT_URI, CHATGPT_REDIRECT_URI, CHATGPT_CALLBACK_REDIRECT_URI])(
	"registration accepts %s",
	async (uri) => {
		const res = await call(registration(uri));

		expect(res.status).toBe(201);
	},
);

test.each([
	"https://evil.example/cb",
	"https://claude.ai/api/mcp/auth_callback/../../evil",
	"https://claude.ai.evil.example/api/mcp/auth_callback",
	"https://chatgpt.com/connector/oauth/a/b",
	"https://chatgpt.com/connector_platform_oauth_redirect?next=https://evil.example",
	"http://evil.example/callback",
	"http://localhost:3118/callback",
	"http://127.0.0.1:53682/any/path",
])("registration refuses %s", async (uri) => {
	const res = await call(registration(uri));

	expect(res.status).toBe(400);
	expect(await res.json()).toMatchObject({
		error: "invalid_redirect_uri",
		error_description: "redirect_uris must be an allowed callback",
	});
});

test("authorize refuses a redirect outside the chat apps' callbacks even when the client registered it", async () => {
	const client = await registerClient(call, ep);
	const evil = "https://evil.example/cb";
	// a client stored before the allowlist existed
	await db.execute({
		sql: 'UPDATE "oauthClient" SET "redirectUris" = ? WHERE "clientId" = ?',
		args: [JSON.stringify([evil]), client.client_id],
	});
	const url = new URL(authorization(ep, client.client_id).url);
	url.searchParams.set("redirect_uri", evil);

	const res = await call(
		new Request(url, {
			headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
		}),
	);

	const target = redirectTarget(res, url.href);
	expect(target.origin + target.pathname).toBe(`${BASE}/api/auth/error`);
	expect(target.searchParams.get("error")).toBe("invalid_redirect");
});

async function startAuthorization(
	options?: AuthorizationOptions,
): Promise<{ a: Authorization; login: URL }> {
	const client = await registerClient(call, ep, options?.redirectUri);
	const a = authorization(ep, client.client_id, options);
	return { a, login: await openAuthorization(call, a) };
}

test("authorize with no session sends the browser to /connect with a request readLoginRequest accepts", async () => {
	const { login } = await startAuthorization();

	expect(login.origin + login.pathname).toBe(`${BASE}/connect`);
	expect(await auth.readLoginRequest(login)).toEqual({
		oauthQuery: login.search.slice(1),
	});
});

test("readLoginRequest refuses a tampered request", async () => {
	const { login } = await startAuthorization();
	const tampered = new URL(login);
	tampered.searchParams.set("redirect_uri", "https://attacker.example/cb");

	expect(await auth.readLoginRequest(tampered)).toBeNull();
});

const ORIGIN = "https://give.example.org" as Origin;
const KEY = "bgk_live_sentinel_51c0";

async function connect(
	origin = ORIGIN,
	options?: AuthorizationOptions,
	key = KEY,
) {
	const { a, login } = await startAuthorization(options);
	const request = await auth.readLoginRequest(login);
	if (!request) throw new Error("login request refused");
	const res = await auth.completeConnection({
		oauthQuery: request.oauthQuery,
		origin,
		orgName: "Example Org",
		key: new Secret(key),
	});
	return { a, res, back: redirectTarget(res, `${BASE}/connect/return`) };
}

test.each([REDIRECT_URI, CHATGPT_REDIRECT_URI, CHATGPT_CALLBACK_REDIRECT_URI])(
	"completeConnection resumes the authorization to %s with a code",
	async (redirectUri) => {
		const { a, back } = await connect(ORIGIN, { redirectUri });

		expect(back.origin + back.pathname).toBe(redirectUri);
		expect(back.searchParams.get("state")).toBe(a.state);
		expect(back.searchParams.get("code")).toMatch(/\S/);
	},
);

async function connectedClient(
	origin = ORIGIN,
	options?: AuthorizationOptions,
	key = KEY,
): Promise<{ clientId: string; tokens: Tokens }> {
	const { a, back } = await connect(origin, options, key);
	const res = await exchangeCode(
		call,
		ep,
		a,
		back.searchParams.get("code") ?? "",
	);
	if (res.status !== 200)
		throw new Error(`token: ${res.status} ${await res.text()}`);
	return { clientId: a.clientId, tokens: (await res.json()) as Tokens };
}

const tokensFor = async (...args: Parameters<typeof connectedClient>) =>
	(await connectedClient(...args)).tokens;

test("the code and its PKCE verifier yield an access token and a refresh token", async () => {
	const tokens = await tokensFor();

	expect(tokens.token_type.toLowerCase()).toBe("bearer");
	expect(tokens.access_token).toMatch(/\S/);
	expect(tokens.refresh_token).toMatch(/\S/);
});

test.each([
	["Claude's request", () => ({ scope: "offline_access" })],
	[
		"ChatGPT's request",
		() => ({ scope: ep.scopes.join(" "), redirectUri: CHATGPT_REDIRECT_URI }),
	],
	["a request with no scope", () => ({})],
])("%s yields a refresh token", async (_, options) => {
	const tokens = await tokensFor(ORIGIN, options());

	expect(tokens.refresh_token).toMatch(/\S/);
});

test("a code sent to ChatGPT's per-connection callback exchanges for tokens", async () => {
	const tokens = await tokensFor(ORIGIN, {
		redirectUri: CHATGPT_CALLBACK_REDIRECT_URI,
	});

	expect(tokens.access_token).toMatch(/\S/);
});

test("a code exchanged with another redirect_uri than it was issued for is refused", async () => {
	const { a, back } = await connect();

	const res = await exchangeCode(
		call,
		ep,
		a,
		back.searchParams.get("code") ?? "",
		{ redirectUri: CHATGPT_REDIRECT_URI },
	);

	await expectInvalidGrant(res);
});

test("the code without the right PKCE verifier yields nothing", async () => {
	const { a, back } = await connect();
	const wrong = { ...a, verifier: "x".repeat(43) };

	const res = await exchangeCode(
		call,
		ep,
		wrong,
		back.searchParams.get("code") ?? "",
	);

	expect(res.status).toBe(401);
	expect(await res.json()).not.toHaveProperty("access_token");
});

const mcpRequest = (authorization?: string) =>
	mcpPost(INITIALIZE, authorization);

test("authenticateMcp resolves a bearer to the user whose connection it was issued for", async () => {
	const tokens = await tokensFor();

	const who = await auth.authenticateMcp(
		mcpRequest(`Bearer ${tokens.access_token}`),
	);

	const connection = await store.get(who?.userId ?? "");
	expect(connection?.origin).toBe(ORIGIN);
});

test.each([
	["no Authorization header", undefined],
	["a garbage bearer", "Bearer not-a-token"],
	["a Basic credential", "Basic dXNlcjpwYXNz"],
])("authenticateMcp refuses %s", async (_, header) => {
	await tokensFor();

	expect(await auth.authenticateMcp(mcpRequest(header))).toBeNull();
});

test("authenticateMcp refuses an expired access token", async () => {
	const tokens = await tokensFor();
	advance((tokens.expires_in + 1) * 1000);

	const who = await auth.authenticateMcp(
		mcpRequest(`Bearer ${tokens.access_token}`),
	);

	expect(who).toBeNull();
});

test("a token issued without a resource is read as /mcp's", async () => {
	const tokens = await tokensFor(ORIGIN, { resource: null });

	const who = await auth.authenticateMcp(
		mcpRequest(`Bearer ${tokens.access_token}`),
	);

	expect((await store.get(who?.userId ?? ""))?.origin).toBe(ORIGIN);
});

test("authenticateMcp refuses a token issued for another resource", async () => {
	const tokens = await tokensFor(ORIGIN, {
		resource: `${BASE}/api/auth/oauth2/userinfo`,
	});

	expect(
		await auth.authenticateMcp(mcpRequest(`Bearer ${tokens.access_token}`)),
	).toBeNull();
});

test("authenticateMcp refuses a JWT-shaped bearer", async () => {
	await tokensFor();
	const jwtShaped = [
		{ alg: "RS256", typ: "JWT", kid: "k" },
		{ sub: "someone", aud: `${BASE}/mcp` },
	]
		.map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
		.concat("c2ln")
		.join(".");

	expect(
		await auth.authenticateMcp(mcpRequest(`Bearer ${jwtShaped}`)),
	).toBeNull();
});

async function refreshed(tokens: Tokens, clientId: string): Promise<Tokens> {
	const res = await refresh(call, ep, clientId, tokens.refresh_token);
	if (res.status !== 200)
		throw new Error(`refresh: ${res.status} ${await res.text()}`);
	return res.json() as Promise<Tokens>;
}

// RFC 6749 §5.2: the answer a chat app reads as "sign in again"
async function expectInvalidGrant(res: Response) {
	expect(res.status).toBe(400);
	expect(await res.json()).toMatchObject({ error: "invalid_grant" });
}

test("a refresh token unused for 89 days still refreshes", async () => {
	const { clientId, tokens } = await connectedClient();
	advance(89 * DAY);

	const res = await refresh(call, ep, clientId, tokens.refresh_token);

	expect(res.status).toBe(200);
});

test("a refresh token unused for 91 days is refused", async () => {
	const { clientId, tokens } = await connectedClient();
	advance(91 * DAY);

	const res = await refresh(call, ep, clientId, tokens.refresh_token);

	await expectInvalidGrant(res);
});

test("a refresh token yields a new access token that /mcp accepts", async () => {
	const { clientId, tokens } = await connectedClient();
	const first = await auth.authenticateMcp(
		mcpRequest(`Bearer ${tokens.access_token}`),
	);

	const next = await refreshed(tokens, clientId);

	expect(next.access_token).not.toBe(tokens.access_token);
	expect(
		await auth.authenticateMcp(mcpRequest(`Bearer ${next.access_token}`)),
	).toEqual(first);
});

// oauth-provider's default `storeTokens: "hashed"`: unpadded base64url SHA-256
const storedToken = (token: string) =>
	createHash("sha256").update(token).digest("base64url");

async function refreshTokenRow(token: string) {
	const { rows } = await db.execute({
		sql: 'SELECT "revoked" FROM "oauthRefreshToken" WHERE "token" = ?',
		args: [storedToken(token)],
	});
	return rows[0];
}

test("a refresh answers with the refresh token it stored and revokes the one it was given", async () => {
	const { clientId, tokens } = await connectedClient();

	const next = await refreshed(tokens, clientId);

	expect(next.refresh_token).not.toBe(tokens.refresh_token);
	expect(await refreshTokenRow(next.refresh_token)).toMatchObject({
		revoked: null,
	});
	const old = await refreshTokenRow(tokens.refresh_token);
	expect(old).toBeDefined();
	expect(old?.revoked).not.toBeNull();
});

test("the refresh token a refresh returns refreshes again, the one it replaced is refused", async () => {
	const { clientId, tokens } = await connectedClient();
	const next = await refreshed(tokens, clientId);

	// the returned token first: replaying the old one revokes its whole family
	expect((await refresh(call, ep, clientId, next.refresh_token)).status).toBe(
		200,
	);
	// past mcp()'s 30s refreshTokenReuseInterval, which replays the old
	// token's answer to a chat app retrying a lost response
	advance(MINUTE);
	await expectInvalidGrant(
		await refresh(call, ep, clientId, tokens.refresh_token),
	);
});

test("a chat app that keeps refreshing stays connected past a month", async () => {
	let { clientId, tokens } = await connectedClient();

	// six refreshes, six days apart
	for (let i = 0; i < 6; i++) {
		advance(6 * DAY);
		tokens = await refreshed(tokens, clientId);
	}

	expect(
		await auth.authenticateMcp(mcpRequest(`Bearer ${tokens.access_token}`)),
	).not.toBeNull();
});

// Refreshes every 80 days, so the refresh token never lapses, until the
// connection's session (a year) is a day past its end.
async function refreshedPastTheYear() {
	let { clientId, tokens } = await connectedClient();
	for (let day = 80; day <= 320; day += 80) {
		advance(80 * DAY);
		tokens = await refreshed(tokens, clientId);
	}
	advance(46 * DAY);
	return { clientId, tokens };
}

test("a refresh after the connection's year is up is refused with invalid_grant", async () => {
	const { clientId, tokens } = await refreshedPastTheYear();

	const res = await refresh(call, ep, clientId, tokens.refresh_token);

	await expectInvalidGrant(res);
});

async function tokenRows() {
	const read = async (table: string) =>
		(await db.execute(`SELECT * FROM "${table}" ORDER BY "id"`)).rows.map(
			(row) => ({ ...row }),
		);
	return {
		refresh: await read("oauthRefreshToken"),
		access: await read("oauthAccessToken"),
	};
}

test("a refresh refused because the year is up revokes, rotates and issues nothing", async () => {
	const { clientId, tokens } = await refreshedPastTheYear();
	const before = await tokenRows();

	await expectInvalidGrant(
		await refresh(call, ep, clientId, tokens.refresh_token),
	);

	expect(await tokenRows()).toEqual(before);
	expect(await refreshTokenRow(tokens.refresh_token)).toMatchObject({
		revoked: null,
	});
});

test("after dropConnection the bearer and refresh token are refused and the row is gone", async () => {
	const { clientId, tokens } = await connectedClient();
	const bearer = mcpRequest(`Bearer ${tokens.access_token}`);
	const who = await auth.authenticateMcp(bearer);
	if (!who) throw new Error("bearer refused before the drop");

	// every table the connection touched holds a row, so an empty one is a delete
	expect(await connectionRows(db)).toEqual(LIVE_CONNECTION_ROWS);

	await auth.dropConnection(who.userId);

	expect(await auth.authenticateMcp(bearer)).toBeNull();
	await expectInvalidGrant(
		await refresh(call, ep, clientId, tokens.refresh_token),
	);
	expect(await store.get(who.userId)).toBeNull();
	expect(await connectionRows(db)).toEqual(NO_CONNECTION_ROWS);
});

test("two connections' tokens resolve to their own connections", async () => {
	const other = "https://other.example.org" as Origin;
	const first = await tokensFor(ORIGIN);
	const second = await tokensFor(other);

	const origins = await Promise.all(
		[first, second].map(async (t) => {
			const who = await auth.authenticateMcp(
				mcpRequest(`Bearer ${t.access_token}`),
			);
			return (await store.get(who?.userId ?? ""))?.origin;
		}),
	);

	expect(origins).toEqual([ORIGIN, other]);
});

test("completeConnection hands the browser no cookie, so its next authorization asks for an address again", async () => {
	const { res } = await connect();
	const client = await registerClient(call, ep);
	const next = authorization(ep, client.client_id);

	const browser = await call(
		new Request(next.url, {
			headers: {
				accept: "text/html",
				"sec-fetch-mode": "navigate",
				cookie: res.headers
					.getSetCookie()
					.map((c) => c.split(";")[0])
					.join("; "),
			},
		}),
	);

	expect(res.headers.getSetCookie()).toEqual([]);
	expect(redirectTarget(browser, next.url).pathname).toBe("/connect");
});

test("completeConnection refuses an expired login request and creates nothing", async () => {
	const { login } = await startAuthorization();
	const request = await auth.readLoginRequest(login);
	advance(11 * MINUTE);

	const outcome = auth.completeConnection({
		oauthQuery: request?.oauthQuery ?? "",
		origin: ORIGIN,
		orgName: "Example Org",
		key: new Secret(KEY),
	});

	await expect(outcome).rejects.toBeInstanceOf(LoginRequestRefused);
	expect(await countRows(db, "connection")).toBe(0);
});

// An auth facade over the same database whose statements matching `failing`
// reject with a message that must not reach a log.
function authFailingOn(failing: RegExp): AuthFacade {
	const broken = failingDb(db);
	broken.failOn(failing, new StoreDown("store down: secret-7f3a"));
	return createAuth({
		db: broken.db,
		connections: store,
		env,
		client: deploymentApi,
	});
}

test("better-auth's own log lines reach only log.ts, by error name with no message", async () => {
	const { clientId, tokens } = await connectedClient();
	// oauth-provider logs this failure and still answers the refresh
	const broken = authFailingOn(
		/^update "oauthRefreshToken" set "rotationReplayResponse"/,
	);
	const lines = captureConsole();

	const res = await refresh(
		(req) => broken.handler(req),
		ep,
		clientId,
		tokens.refresh_token,
	);

	expect(res.status).toBe(200);
	expect(lines()).toEqual([
		["error", '{"kind":"error","where":"auth","errorName":"StoreDown"}'],
	]);
});

test("an unexpected failure inside better-auth rejects the handler and writes nothing to the console", async () => {
	const broken = authFailingOn(/^insert into "oauthClient"/);
	const lines = captureConsole();

	const outcome = registerClient((req) => broken.handler(req), ep);

	await expect(outcome).rejects.toBeInstanceOf(StoreDown);
	expect(lines()).toEqual([]);
});

test("open registration answers 429 past sixty a minute from one address", async () => {
	const register = () =>
		call(
			new Request(ep.registration, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-forwarded-for": "203.0.113.7",
				},
				body: JSON.stringify({
					redirect_uris: [REDIRECT_URI],
					token_endpoint_auth_method: "none",
				}),
			}),
		);
	const statuses: number[] = [];
	for (let i = 0; i < 61; i++) statuses.push((await register()).status);

	expect(statuses.slice(0, 60).every((s) => s < 300)).toBe(true);
	expect(statuses[60]).toBe(429);
});

test("a resume that ends without a code undoes the connection and passes the error redirect on", async () => {
	const { a, login } = await startAuthorization();
	await db.execute({
		sql: 'UPDATE "oauthClient" SET disabled = 1 WHERE "clientId" = ?',
		args: [a.clientId],
	});

	const res = await auth.completeConnection({
		oauthQuery: login.search.slice(1),
		origin: ORIGIN,
		orgName: "Example Org",
		key: new Secret(KEY),
	});

	expect(redirectTarget(res, BASE).searchParams.get("code")).toBeNull();
	expect(await countRows(db, "connection")).toBe(0);
	expect(await countRows(db, "user")).toBe(0);
});

test("a failure after the user is created undoes the connection and rethrows", async () => {
	const lost = new Error("write landed, answer lost");
	const flaky: Connections = {
		...store,
		async insert(r) {
			await store.insert(r);
			throw lost;
		},
	};
	const flakyAuth = createAuth({
		db,
		connections: flaky,
		env,
		client: deploymentApi,
	});
	const client = await registerClient(call, ep);
	const login = await openAuthorization(
		call,
		authorization(ep, client.client_id),
	);

	const outcome = flakyAuth.completeConnection({
		oauthQuery: login.search.slice(1),
		origin: ORIGIN,
		orgName: "Example Org",
		key: new Secret(KEY),
	});

	await expect(outcome).rejects.toBe(lost);
	expect(await countRows(db, "connection")).toBe(0);
	expect(await countRows(db, "user")).toBe(0);
});

async function issuer(): Promise<string> {
	const res = await call(
		new Request(`${BASE}/.well-known/oauth-authorization-server/api/auth`),
	);
	return String(((await res.json()) as { issuer: unknown }).issuer);
}

const countConnectionRows = () =>
	Promise.all(["user", "session", "connection"].map((t) => countRows(db, t)));

test("denyConnection answers the client's redirect_uri with access_denied, its state and the issuer, and creates nothing", async () => {
	// one live connection, so an unchanged count is a read that moves
	await connect();
	const before = await countConnectionRows();
	expect(before).toEqual([1, 1, 1]);
	const { a, login } = await startAuthorization();

	const res = await auth.denyConnection(login.search.slice(1));

	const back = redirectTarget(res, `${BASE}/connect`);
	expect(back.origin + back.pathname).toBe(REDIRECT_URI);
	expect(back.searchParams.get("error")).toBe("access_denied");
	expect(back.searchParams.get("state")).toBe(a.state);
	expect(back.searchParams.get("iss")).toBe(await issuer());
	expect(back.searchParams.get("code")).toBeNull();
	expect(await countConnectionRows()).toEqual(before);
});

test("denyConnection refuses a tampered login request", async () => {
	const { login } = await startAuthorization();
	const tampered = new URL(login);
	tampered.searchParams.set("redirect_uri", "https://attacker.example/cb");

	const outcome = auth.denyConnection(tampered.search.slice(1));

	await expect(outcome).rejects.toBeInstanceOf(LoginRequestRefused);
});

test("denyConnection refuses an expired login request", async () => {
	const { login } = await startAuthorization();
	advance(11 * MINUTE);

	const outcome = auth.denyConnection(login.search.slice(1));

	await expect(outcome).rejects.toBeInstanceOf(LoginRequestRefused);
});

async function connectedUser(key = KEY): Promise<string> {
	const tokens = await tokensFor(ORIGIN, undefined, key);
	const who = await auth.authenticateMcp(
		mcpRequest(`Bearer ${tokens.access_token}`),
	);
	if (!who) throw new Error("bearer refused");
	return who.userId;
}

test("sweep drops a connection whose refresh token has expired, row and user", async () => {
	const userId = await connectedUser();
	advance(91 * DAY);

	const swept = await auth.sweep();

	expect(swept.connections).toBe(1);
	expect(await store.get(userId)).toBeNull();
	expect(await connectionRows(db)).toEqual(NO_CONNECTION_ROWS);
});

test("sweep keeps going past a user whose drop throws, so that user can't jam every night", async () => {
	const stuck = await connectedUser();
	const next = await connectedUser();
	advance(91 * DAY);
	const original = store.delete.bind(store);
	vi.spyOn(store, "delete").mockImplementation(async (userId) => {
		if (userId === stuck) throw new TypeError("store down");
		return original(userId);
	});
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});

	const swept = await auth.sweep();

	expect(swept.connections).toBe(1);
	expect(await store.get(next)).toBeNull();
	expect(errors.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(
		{ kind: "error", where: "sweep", errorName: "TypeError" },
	);
});

test("sweep drops a connection whose year is up though its refresh token is alive", async () => {
	await refreshedPastTheYear();

	const swept = await auth.sweep();

	expect(swept.connections).toBe(1);
	expect(await connectionRows(db)).toEqual(NO_CONNECTION_ROWS);
});

test("sweep finishes a drop that failed after deleting the row, so its refresh is refused", async () => {
	const { clientId, tokens } = await connectedClient();
	const who = await auth.authenticateMcp(
		mcpRequest(`Bearer ${tokens.access_token}`),
	);
	// dropConnection's first step, the rest lost to a store failure
	await store.delete(who?.userId ?? "");
	advance(61 * MINUTE);

	const swept = await auth.sweep();

	expect(swept.connections).toBe(1);
	expect(await countRows(db, "user")).toBe(0);
	await expectInvalidGrant(
		await refresh(call, ep, clientId, tokens.refresh_token),
	);
});

test("sweep keeps a connection whose refresh token is alive after its access token expired", async () => {
	const userId = await connectedUser();
	advance(89 * DAY);

	const swept = await auth.sweep();

	expect(swept.connections).toBe(0);
	expect((await store.get(userId))?.origin).toBe(ORIGIN);
});

test("sweep keeps a connection under an hour old whose code is not yet exchanged", async () => {
	await connect();
	advance(59 * MINUTE);

	const swept = await auth.sweep();

	expect(swept.connections).toBe(0);
	expect(await countRows(db, "connection")).toBe(1);
});

test("sweep drops a connection over an hour old that never exchanged its code", async () => {
	await connect();
	advance(61 * MINUTE);

	const swept = await auth.sweep();

	expect(swept.connections).toBe(1);
	expect(await countRows(db, "connection")).toBe(0);
});

async function replayOf(token: string) {
	const { rows } = await db.execute({
		sql: `SELECT "rotationReplayResponse" AS response, "rotatedAt" AS rotatedAt, "rotationReplayExpiresAt" AS expiresAt
			FROM "oauthRefreshToken" WHERE "token" = ?`,
		args: [storedToken(token)],
	});
	return rows[0];
}

test("a retried refresh inside the reuse window replays the previous answer, and the sweep clears that copy once the window has passed", async () => {
	advance(0);
	const { clientId, tokens } = await connectedClient();
	const next = await refreshed(tokens, clientId);
	const stored = await replayOf(tokens.refresh_token);
	const response = stored?.response;
	const expiresAt = new Date(String(stored?.expiresAt)).getTime();

	expect(typeof response).toBe("string");
	expect(String(response).length).toBeGreaterThan(0);
	expect(expiresAt - new Date(String(stored?.rotatedAt)).getTime()).toBe(
		30_000,
	);

	await auth.sweep();
	expect((await replayOf(tokens.refresh_token))?.response).toBe(response);
	const replay = await refresh(call, ep, clientId, tokens.refresh_token);
	expect(replay.status).toBe(200);
	expect(await replay.json()).toMatchObject({
		access_token: next.access_token,
		refresh_token: next.refresh_token,
	});

	advance(expiresAt - Date.now());
	await auth.sweep();
	expect((await replayOf(tokens.refresh_token))?.response).toBe(response);

	advance(1);
	await auth.sweep();
	expect((await replayOf(tokens.refresh_token))?.response).toBeNull();
	expect(await refreshTokenRow(tokens.refresh_token)).toBeDefined();
});

async function idsIn(
	table: "rateLimit" | "verification" | "oauthClientAssertion",
) {
	const { rows } = await db.execute(
		`SELECT "id" FROM "${table}" ORDER BY "id"`,
	);
	return rows.map((row) => String(row.id));
}

async function insertRateLimit(id: string, lastRequest: number) {
	await db.execute({
		sql: `INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest") VALUES (?1, ?2, 1, ?3)`,
		args: [id, `203.0.113.8|${id}`, lastRequest],
	});
}

async function insertVerification(id: string, expiresAt: string) {
	const at = new Date(expiresAt).toISOString();
	await db.execute({
		sql: `INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
			VALUES (?1, ?1, '{}', ?2, ?2, ?2)`,
		args: [id, at],
	});
}

async function insertClientAssertion(id: string, expiresAt: string) {
	await db.execute({
		sql: `INSERT INTO "oauthClientAssertion" ("id", "expiresAt") VALUES (?1, ?2)`,
		args: [id, expiresAt],
	});
}

test("sweep deletes rate-limit rows past their retention and expired verification rows", async () => {
	advance(0);
	// discover(), in beforeEach, already counted a request
	await db.execute(`DELETE FROM "rateLimit"`);
	await db.execute(`DELETE FROM "verification"`);
	const now = Date.now();
	const retentionMs = RATE_LIMIT_RETENTION * 1000;
	await insertRateLimit("edge", now - retentionMs);
	await insertRateLimit("fresh", now - retentionMs + 1);
	await insertRateLimit("stale", now - retentionMs - 1);
	await insertVerification("due", new Date(now).toISOString());
	await insertVerification("expired", new Date(now - MINUTE).toISOString());
	await insertVerification("live", new Date(now + 10 * MINUTE).toISOString());

	const swept = await auth.sweep();

	expect(swept).toEqual({ connections: 0, more: false });
	expect(await idsIn("rateLimit")).toEqual(["edge", "fresh"]);
	expect(await idsIn("verification")).toEqual(["due", "live"]);
});

test("sweep deletes expired client-assertion rows and keeps one that has not expired", async () => {
	advance(0);
	const now = Date.now();
	await insertClientAssertion("due", new Date(now).toISOString());
	await insertClientAssertion("expired", new Date(now - 1000).toISOString());
	await insertClientAssertion("live", new Date(now + MINUTE).toISOString());

	await auth.sweep();

	expect(await idsIn("oauthClientAssertion")).toEqual(["due", "live"]);
});

test("sweep drops an expired connection and the stale rows in the same call", async () => {
	await connectedUser();
	advance(91 * DAY);
	const now = Date.now();
	const retentionMs = RATE_LIMIT_RETENTION * 1000;
	await insertRateLimit("fresh", now);
	await insertRateLimit("stale", now - retentionMs - 1);
	await insertVerification("expired", new Date(now - MINUTE).toISOString());
	await insertVerification("live", new Date(now + MINUTE).toISOString());

	const swept = await auth.sweep();

	expect(swept.connections).toBe(1);
	expect(await countRows(db, "connection")).toBe(0);
	expect(await countRows(db, "oauthClient")).toBe(1);
	expect(await idsIn("rateLimit")).toEqual(["fresh"]);
	expect(await idsIn("verification")).toEqual(["live"]);
});

test("a registered client outlives every sweep, so a chat app reusing it a year on reaches /connect", async () => {
	const client = await registerClient(call, ep, CHATGPT_REDIRECT_URI);
	advance(400 * DAY);
	await auth.sweep();

	const login = await openAuthorization(
		call,
		authorization(ep, client.client_id, { redirectUri: CHATGPT_REDIRECT_URI }),
	);

	expect(login.origin + login.pathname).toBe(`${BASE}/connect`);
});

test("one sweep drops at most 500 connections and says there are more, the next takes the rest", async () => {
	await seedDeadUsers(db, 501);

	const first = await auth.sweep();
	const second = await auth.sweep();

	expect(first).toEqual({ connections: 500, more: true });
	expect(second).toEqual({ connections: 1, more: false });
});

// --- dropping tells the deployment ------------------------------------------------

const DISCONNECT_PATH = "/connector/v1/disconnect";

/** A key the fake deployment minted and still accepts. */
const liveKey = async () =>
	(
		await deploymentApi.exchange(deployment.origin, deployment.mintCode())
	).key.reveal();

const disconnectsSent = () =>
	deployment.calls
		.filter((c) => c.path === DISCONNECT_PATH)
		.map(({ method, host, authorization }) => ({
			method,
			host,
			authorization,
		}));

const keyAccepted = (key: string) =>
	deploymentApi.call(
		{ origin: ORIGIN, key: new Secret(key) },
		"campaigns.list",
		{},
	);

test("a drop tells the deployment at the row's origin to revoke the connection's key, while the row is still there", async () => {
	const key = await liveKey();
	const userId = await connectedUser(key);
	await keyAccepted(key);
	const rowWhenTold: (string | null)[] = [];
	deployment.intercept(async (req) => {
		if (new URL(req.url).pathname === DISCONNECT_PATH)
			rowWhenTold.push((await store.get(userId))?.origin ?? null);
		return undefined;
	});

	await auth.dropConnection(userId);

	expect(disconnectsSent()).toEqual([
		{ method: "POST", host: deployment.host, authorization: `Bearer ${key}` },
	]);
	expect(rowWhenTold).toEqual([ORIGIN]);
	await expect(keyAccepted(key)).rejects.toBeInstanceOf(KeyRefused);
	expect(await store.get(userId)).toBeNull();
});

const disconnectFailures: [
	string,
	string,
	(userId: string) => void,
	(() => Promise<void>)?,
][] = [
	[
		"answers 503",
		"Unreachable",
		() =>
			deployment.intercept((req) =>
				new URL(req.url).pathname === DISCONNECT_PATH
					? new Response("down", { status: 503 })
					: undefined,
			),
	],
	[
		"never answers",
		"Unreachable",
		() => {
			deployment.intercept(hang);
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		},
		async () => {
			await vi.waitFor(() => expect(disconnectsSent()).toHaveLength(1));
			await vi.advanceTimersByTimeAsync(5_000);
		},
	],
	[
		"can't be read from the store",
		"StoreDown",
		(userId) => {
			const read = store.get.bind(store);
			vi.spyOn(store, "get").mockImplementation(async (id) => {
				if (id === userId) throw new StoreDown(`store down: ${KEY}`);
				return read(id);
			});
		},
	],
];

test.each(disconnectFailures)(
	"a drop whose disconnect %s still ends the connection and logs only the error's name",
	async (_, errorName, arrange, settle) => {
		const { clientId, tokens } = await connectedClient();
		const bearer = mcpRequest(`Bearer ${tokens.access_token}`);
		const userId = (await auth.authenticateMcp(bearer))?.userId ?? "";
		const { rows } = await db.execute("SELECT key_ct FROM connection");
		const sealed = String(rows[0]?.key_ct);
		arrange(userId);
		const lines = captureConsole();

		const drop = auth.dropConnection(userId);
		await settle?.();
		await drop;

		const written = JSON.stringify(lines());
		expect(written).not.toContain(KEY);
		expect(written).not.toContain(sealed);
		expect(lines()).toEqual([
			[
				"error",
				`{"kind":"error","where":"disconnect","errorName":"${errorName}"}`,
			],
		]);
		expect(await connectionRows(db)).toEqual(NO_CONNECTION_ROWS);
		expect(await auth.authenticateMcp(bearer)).toBeNull();
		await expectInvalidGrant(
			await refresh(call, ep, clientId, tokens.refresh_token),
		);
	},
);

test.each([
	[
		"a resume that ends without a code",
		async (clientId: string) => {
			await db.execute({
				sql: 'UPDATE "oauthClient" SET disabled = 1 WHERE "clientId" = ?',
				args: [clientId],
			});
			return auth;
		},
	],
	[
		"a failure after the row is written",
		async () => {
			const flaky: Connections = {
				...store,
				async insert(r) {
					await store.insert(r);
					throw new StoreDown("write landed, answer lost");
				},
			};
			return createAuth({
				db,
				connections: flaky,
				env,
				client: deploymentApi,
			});
		},
	],
])("%s revokes the key the deployment just minted", async (_, arrange) => {
	const key = await liveKey();
	const { a, login } = await startAuthorization();
	const completing = await arrange(a.clientId);

	await completing
		.completeConnection({
			oauthQuery: login.search.slice(1),
			origin: ORIGIN,
			orgName: "Example Org",
			key: new Secret(key),
		})
		.catch(() => {});

	expect(disconnectsSent()).toEqual([
		{ method: "POST", host: deployment.host, authorization: `Bearer ${key}` },
	]);
	await expect(keyAccepted(key)).rejects.toBeInstanceOf(KeyRefused);
	expect(await countRows(db, "connection")).toBe(0);
});

test("sweep tells the deployment of each connection it drops", async () => {
	const key = await liveKey();
	await connectedUser(key);
	advance(91 * DAY);

	const swept = await auth.sweep();

	expect(swept.connections).toBe(1);
	expect(disconnectsSent()).toEqual([
		{ method: "POST", host: deployment.host, authorization: `Bearer ${key}` },
	]);
	await expect(keyAccepted(key)).rejects.toBeInstanceOf(KeyRefused);
});

test("a full sweep batch whose deployments all hang finishes inside the cron's budget, every connection dropped", async () => {
	await seedDeadUsers(db, 500);
	for (let i = 1; i <= 500; i++) {
		await store.insert({
			userId: `u${i}`,
			origin: ORIGIN,
			orgName: "Example Org",
			key: new Secret(`${KEY}_${i}`),
		});
	}
	deployment.intercept(hang);
	captureConsole();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	let swept: { connections: number; more: boolean } | undefined;
	const sweeping = auth.sweep().then((s) => {
		swept = s;
	});

	let waited = 0;
	while (!swept && waited < 60_000) {
		await new Promise((resolve) => setImmediate(resolve));
		await vi.advanceTimersByTimeAsync(1_000);
		waited += 1_000;
	}

	expect(waited).toBeLessThanOrEqual(15_000);
	await sweeping;
	// what the batch left in flight runs out on its own timeout
	await vi.advanceTimersByTimeAsync(5_000);
	expect(swept).toEqual({ connections: 500, more: true });
	expect(disconnectsSent().length).toBeGreaterThanOrEqual(50);
	expect(await countRows(db, "connection")).toBe(0);
});

// --- a chat app revoking its tokens ------------------------------------------------

// RFC 7009, as a public client sends it
const revokeVia = (
	via: Call,
	clientId: string,
	token: string,
	hint = "refresh_token",
) =>
	via(
		new Request(`${BASE}/api/auth/oauth2/revoke`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				token,
				client_id: clientId,
				token_type_hint: hint,
			}),
		}),
	);

const revoke = (clientId: string, token: string, hint?: string) =>
	revokeVia(call, clientId, token, hint);

test("revoking the connection's refresh token ends the connection and revokes its key", async () => {
	const key = await liveKey();
	const { clientId, tokens } = await connectedClient(ORIGIN, undefined, key);

	const res = await revoke(clientId, tokens.refresh_token, "refresh_token");

	expect(res.status).toBe(200);
	expect(disconnectsSent()).toEqual([
		{ method: "POST", host: deployment.host, authorization: `Bearer ${key}` },
	]);
	expect(await connectionRows(db)).toEqual(NO_CONNECTION_ROWS);
});

test.each([
	[
		"revoking only the access token",
		async (clientId: string, tokens: Tokens) =>
			revoke(clientId, tokens.access_token, "access_token"),
	],
	[
		"another client revoking the refresh token",
		async (_: string, tokens: Tokens) =>
			revoke(
				(await registerClient(call, ep)).client_id,
				tokens.refresh_token,
				"refresh_token",
			),
	],
	[
		"a refresh",
		async (clientId: string, tokens: Tokens) =>
			refresh(call, ep, clientId, tokens.refresh_token),
	],
])("%s leaves the connection and the key alone", async (_, act) => {
	const { clientId, tokens } = await connectedClient();

	expect((await act(clientId, tokens)).status).toBe(200);

	expect(disconnectsSent()).toEqual([]);
	expect(await countRows(db, "connection")).toBe(1);
	expect(await countRows(db, "user")).toBe(1);
});

test("revoking a refresh token rotated out within the reuse grace leaves the connection to the sweep", async () => {
	const { clientId, tokens } = await connectedClient();
	const next = await refreshed(tokens, clientId);

	await revoke(clientId, tokens.refresh_token, "refresh_token");

	expect(disconnectsSent()).toEqual([]);
	expect(await countRows(db, "connection")).toBe(1);
	// oauth-provider's own answer to a replayed token: the whole family goes
	await expectInvalidGrant(
		await refresh(call, ep, clientId, next.refresh_token),
	);
});

test("a store failure while the revoke ends the connection still answers the revoke, logging only the error's name", async () => {
	const { clientId, tokens } = await connectedClient();
	const broken = authFailingOn(/^delete from "oauthConsent"/);
	const lines = captureConsole();

	const res = await revokeVia(
		(req) => broken.handler(req),
		clientId,
		tokens.refresh_token,
	);

	expect(res.status).toBe(200);
	expect(lines()).toEqual([
		["error", '{"kind":"error","where":"auth","errorName":"StoreDown"}'],
	]);
});

test("a revoke refused on its own is left alone: no lookup, no drop", async () => {
	const { tokens } = await connectedClient();
	// a lookup would surface as a logged StoreDown
	const broken = authFailingOn(/^select .* from "oauthRefreshToken"/);
	const lines = captureConsole();

	const res = await revokeVia(
		(req) => broken.handler(req),
		"no-such-client",
		tokens.refresh_token,
	);

	expect(await res.json()).toMatchObject({ error: "invalid_client" });
	expect(lines()).toEqual([]);
	expect(await countRows(db, "connection")).toBe(1);
});
