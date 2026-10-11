import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	type Authorization,
	authorization,
	type Call,
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
import { type Connections, connections, createDb, type Db } from "../db";
import { migrate } from "../db/migrate";
import type { Origin } from "../deployment/origin";
import type { Env } from "../env";
import { Secret } from "../secret";
import { type AuthFacade, createAuth, LoginRequestRefused } from "./index";

const BASE = "https://connect.example";

const env: Env = {
	PUBLIC_URL: BASE,
	TURSO_DATABASE_URL: "file::memory:",
	BETTER_AUTH_SECRET: "test-better-auth-secret-aaaaaaaaaaaaaaaa",
	CONNECTION_KEY_SECRET: "test-connection-key-secret-aaaaaaaaaaaa",
};

let db: Db;
let store: Connections;
let auth: AuthFacade;
let call: Call;
let ep: Endpoints;

beforeEach(async () => {
	db = createDb({ url: ":memory:" });
	await migrate(db);
	store = connections(db, env.CONNECTION_KEY_SECRET);
	auth = createAuth({ db, connections: store, env });
	call = (req) => auth.handler(req);
	ep = await discover(call, BASE);
	return () => db.close();
});

afterEach(() => {
	vi.useRealTimers();
});

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
	});
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
			// a desktop or CLI client on loopback declares itself native
			application_type: redirectUri.startsWith("http:") ? "native" : "web",
		}),
	});
}

test.each([
	"https://claude.ai/api/mcp/auth_callback",
	"https://chatgpt.com/connector_platform_oauth_redirect",
	"https://chatgpt.com/connector/oauth/AbC_12-x",
	"http://localhost:3118/callback",
	"http://127.0.0.1:53682/any/path",
])("registration accepts %s", async (uri) => {
	const res = await call(registration(uri));

	expect(res.status).toBe(201);
});

test.each([
	"https://evil.example/cb",
	"https://claude.ai/api/mcp/auth_callback/../../evil",
	"https://claude.ai.evil.example/api/mcp/auth_callback",
	"https://chatgpt.com/connector/oauth/a/b",
	"https://chatgpt.com/connector_platform_oauth_redirect?next=https://evil.example",
	"http://evil.example/callback",
])("registration refuses %s", async (uri) => {
	const res = await call(registration(uri));

	expect(res.status).toBe(400);
	expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
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

	expect(res.headers.get("location") ?? "").not.toContain("evil.example");
	expect(res.headers.get("location") ?? "").not.toMatch(/^\/connect/);
});

async function startAuthorization(
	options?: Parameters<typeof authorization>[2],
): Promise<{ a: Authorization; login: URL }> {
	const client = await registerClient(call, ep);
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
	options?: Parameters<typeof authorization>[2],
) {
	const { a, login } = await startAuthorization(options);
	const request = await auth.readLoginRequest(login);
	if (!request) throw new Error("login request refused");
	const res = await auth.completeConnection({
		oauthQuery: request.oauthQuery,
		origin,
		orgName: "Example Org",
		key: new Secret(KEY),
	});
	return { a, res, back: redirectTarget(res, `${BASE}/connect/return`) };
}

test("completeConnection resumes the authorization to the client's redirect_uri with a code", async () => {
	const { a, back } = await connect();

	expect(back.origin + back.pathname).toBe(REDIRECT_URI);
	expect(back.searchParams.get("state")).toBe(a.state);
	expect(back.searchParams.get("code")).toMatch(/\S/);
});

async function connectedClient(
	origin = ORIGIN,
	options?: Parameters<typeof authorization>[2],
): Promise<{ clientId: string; tokens: Tokens }> {
	const { a, back } = await connect(origin, options);
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

function mcpRequest(authorization?: string): Request {
	return new Request(`${BASE}/mcp`, {
		method: "POST",
		headers: authorization ? { authorization } : {},
	});
}

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
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + (tokens.expires_in + 1) * 1000);

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

const DAY = 24 * 60 * 60 * 1000;

test("a refresh token unused for 89 days still refreshes", async () => {
	const { clientId, tokens } = await connectedClient();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + 89 * DAY);

	const res = await refresh(call, ep, clientId, tokens.refresh_token);

	expect(res.status).toBe(200);
});

test("a refresh token unused for 91 days is refused", async () => {
	const { clientId, tokens } = await connectedClient();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + 91 * DAY);

	const res = await refresh(call, ep, clientId, tokens.refresh_token);

	expect(res.status).not.toBe(200);
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

test("a chat app that keeps refreshing stays connected past a month", async () => {
	let { clientId, tokens } = await connectedClient();
	vi.useFakeTimers({ toFake: ["Date"] });

	// six refreshes, six days apart
	for (let i = 0; i < 6; i++) {
		vi.setSystemTime(Date.now() + 6 * DAY);
		tokens = await refreshed(tokens, clientId);
	}

	expect(
		await auth.authenticateMcp(mcpRequest(`Bearer ${tokens.access_token}`)),
	).not.toBeNull();
});

test("after dropConnection the bearer and refresh token are refused and the row is gone", async () => {
	const { clientId, tokens } = await connectedClient();
	const bearer = mcpRequest(`Bearer ${tokens.access_token}`);
	const who = await auth.authenticateMcp(bearer);
	if (!who) throw new Error("bearer refused before the drop");

	await auth.dropConnection(who.userId);

	expect(await auth.authenticateMcp(bearer)).toBeNull();
	expect(
		(await refresh(call, ep, clientId, tokens.refresh_token)).status,
	).not.toBe(200);
	expect(await store.get(who.userId)).toBeNull();
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
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + 11 * 60 * 1000);

	const outcome = auth.completeConnection({
		oauthQuery: request?.oauthQuery ?? "",
		origin: ORIGIN,
		orgName: "Example Org",
		key: new Secret(KEY),
	});

	await expect(outcome).rejects.toBeInstanceOf(LoginRequestRefused);
	expect(await countRows("connection")).toBe(0);
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

async function countRows(table: string): Promise<number> {
	const { rows } = await db.execute(`SELECT count(*) AS n FROM "${table}"`);
	return Number(rows[0]?.n);
}

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
	expect(await countRows("connection")).toBe(0);
	expect(await countRows("user")).toBe(0);
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
	const flakyAuth = createAuth({ db, connections: flaky, env });
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
	expect(await countRows("connection")).toBe(0);
	expect(await countRows("user")).toBe(0);
});

async function issuer(): Promise<string> {
	const res = await call(
		new Request(`${BASE}/.well-known/oauth-authorization-server/api/auth`),
	);
	return String(((await res.json()) as { issuer: unknown }).issuer);
}

const countConnectionRows = () =>
	Promise.all(["user", "session", "connection"].map(countRows));

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
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + 11 * 60 * 1000);

	const outcome = auth.denyConnection(login.search.slice(1));

	await expect(outcome).rejects.toBeInstanceOf(LoginRequestRefused);
});
