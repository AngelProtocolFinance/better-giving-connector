import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { composeApp } from "../src/app";
import type { AuthFacade } from "../src/auth";
import { connections, createDb, type Db } from "../src/db";
import { migrate } from "../src/db/migrate";
import type { Env } from "../src/env";
import { Secret } from "../src/secret";
import { type FakeDeployment, fakeDeployment } from "./fake-deployment";
import {
	authorization,
	type Call,
	discover,
	exchangeCode,
	openAuthorization,
	redirectTarget,
	registerClient,
	type Tokens,
} from "./oauth";

const BASE = "https://connect.example";

const env: Env = {
	PUBLIC_URL: BASE,
	TURSO_DATABASE_URL: "file::memory:",
	BETTER_AUTH_SECRET: "test-better-auth-secret-aaaaaaaaaaaaaaaa",
	CONNECTION_KEY_SECRET: "test-connection-key-secret-aaaaaaaaaaaa",
};

// better-auth seeds its tables while it starts; a test that never
// reaches auth would otherwise close the database under that write.
const warmUp = (request: Call) =>
	request(new Request(`${BASE}/.well-known/oauth-protected-resource`));

let db: Db;
let deployment: FakeDeployment;
let auth: AuthFacade;
let call: Call;

beforeEach(async () => {
	db = createDb({ url: ":memory:" });
	await migrate(db);
	deployment = fakeDeployment({ name: "Hope Shelter" });
	const composed = composeApp({ env, db, fetch: deployment.fetch });
	auth = composed.auth;
	call = async (req) => composed.app.request(req);
	await warmUp(call);
	return () => db.close();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// The chat app's sign-in, with completeConnection standing in for the
// operator's address page and Allow until /connect exists.
async function connect(): Promise<Tokens> {
	const ep = await discover(call, BASE);
	const client = await registerClient(call, ep);
	const a = authorization(ep, client.client_id);
	const login = await openAuthorization(call, a);
	const request = await auth.readLoginRequest(login);
	if (!request) throw new Error("login request refused");
	const done = await auth.completeConnection({
		oauthQuery: request.oauthQuery,
		origin: deployment.origin,
		orgName: "Hope Shelter",
		key: new Secret("bgk_test_key"),
	});
	const code = redirectTarget(done, login.href).searchParams.get("code") ?? "";
	const res = await exchangeCode(call, ep, a, code);
	if (res.status !== 200) throw new Error(`token: ${res.status}`);
	return res.json() as Promise<Tokens>;
}

test.each([
	["/.well-known/oauth-protected-resource", { resource: `${BASE}/mcp` }],
	["/.well-known/oauth-protected-resource/mcp", { resource: `${BASE}/mcp` }],
	[
		"/.well-known/oauth-authorization-server/api/auth",
		{ issuer: `${BASE}/api/auth` },
	],
])("serves OAuth metadata at %s", async (path, expected) => {
	const res = await call(new Request(`${BASE}${path}`));

	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject(expected);
});

const RESOURCE_METADATA = `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`;

function mcpPost(
	body: unknown,
	authorization?: string,
	headers: Record<string, string> = {},
): Request {
	return new Request(`${BASE}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(authorization ? { authorization } : {}),
			...headers,
		},
		body: JSON.stringify(body),
	});
}

const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "chat-app", version: "1.0.0" },
	},
};

function expectSignInChallenge(res: Response) {
	expect(res.status).toBe(401);
	expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
	expect(res.headers.get("www-authenticate")).toContain(RESOURCE_METADATA);
}

test.each([
	["no bearer", undefined],
	["a garbage bearer", "Bearer not-a-token"],
])("/mcp with %s asks the chat app to sign in", async (_, authorization) => {
	expectSignInChallenge(await call(mcpPost(INITIALIZE, authorization)));
});

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies, read field by field
type RpcBody = { result?: any };

// A JSON-RPC response from /mcp, whether it came as JSON or as one SSE event.
async function rpc(res: Response): Promise<RpcBody> {
	const text = await res.text();
	if (!res.headers.get("content-type")?.startsWith("text/event-stream")) {
		return JSON.parse(text);
	}
	const data = text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("");
	return JSON.parse(data);
}

test("a signed-in chat app initializes and lists tools, told whose site it acts on", async () => {
	const { access_token } = await connect();
	const bearer = `Bearer ${access_token}`;

	const init = await call(mcpPost(INITIALIZE, bearer));
	const listed = await call(
		mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, bearer, {
			"mcp-protocol-version": "2025-06-18",
		}),
	);

	expect(init.status).toBe(200);
	const { result } = await rpc(init);
	expect(result.serverInfo.name).toBe("Better Giving");
	expect(result.instructions).toContain("Hope Shelter");
	expect(listed.status).toBe(200);
	expect((await rpc(listed)).result).toEqual({ tools: [] });
});

async function userOf(bearer: string): Promise<string> {
	const who = await auth.authenticateMcp(mcpPost(INITIALIZE, bearer));
	if (!who) throw new Error("bearer refused");
	return who.userId;
}

test("a bearer whose connection row is gone asks the chat app to sign in again", async () => {
	const bearer = `Bearer ${(await connect()).access_token}`;
	await connections(db, env.CONNECTION_KEY_SECRET).delete(await userOf(bearer));

	expectSignInChallenge(await call(mcpPost(INITIALIZE, bearer)));
});

test("a connection whose key can't be decrypted is dropped and its bearer refused", async () => {
	const bearer = `Bearer ${(await connect()).access_token}`;
	const rotated = composeApp({
		env: {
			...env,
			CONNECTION_KEY_SECRET: "another-connection-key-secret-bbbbbbbb",
		},
		db,
		fetch: deployment.fetch,
	});

	const res = await rotated.app.request(mcpPost(INITIALIZE, bearer));

	expectSignInChallenge(res);
	expect(await auth.authenticateMcp(mcpPost(INITIALIZE, bearer))).toBeNull();
	expectSignInChallenge(await call(mcpPost(INITIALIZE, bearer)));
});

test("an unknown path is 404", async () => {
	const res = await call(new Request(`${BASE}/nowhere`));

	expect(res.status).toBe(404);
});

class StoreDown extends Error {
	override name = "StoreDown";
}
const DETAIL = "sentinel-detail-7f3a";

// The whole app, already serving, over a database that throws once `fail()`
// is called.
async function appOverFailingDb() {
	let failing = false;
	const failingDb = new Proxy(db, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (failing) throw new StoreDown(DETAIL);
				return value.apply(target, args);
			};
		},
	});
	const { app } = composeApp({ env, db: failingDb, fetch: deployment.fetch });
	await warmUp(async (req) => app.request(req));
	return {
		fail: () => {
			failing = true;
		},
		request: (req: Request) => app.request(req),
	};
}

test("a thrown error answers 500 with a generic body", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const app = await appOverFailingDb();
	app.fail();

	const res = await app.request(mcpPost(INITIALIZE, "Bearer some-token"));

	expect(res.status).toBe(500);
	expect(await res.json()).toEqual({ error: "internal_error" });
});

test("a thrown error logs one line naming only the error", async () => {
	const lines = vi.spyOn(console, "error").mockImplementation(() => {});
	const app = await appOverFailingDb();
	app.fail();

	await app.request(mcpPost(INITIALIZE, "Bearer some-token"));

	expect(lines.mock.calls).toEqual([
		[JSON.stringify({ kind: "error", where: "app", errorName: "StoreDown" })],
	]);
});
