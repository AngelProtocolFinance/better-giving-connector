import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app";
import { connections, createDb, type Db } from "../src/db";
import { migrate } from "../src/db/migrate";
import { type FakeDeployment, fakeDeployment } from "./fake-deployment";
import { BASE, env, INITIALIZE, mcpPost, rpc, warmUp } from "./harness";
import { type Call, refresh } from "./oauth";
import { type ConnectFlow, connectFlow } from "./operator";

let db: Db;
let deployment: FakeDeployment;
let call: Call;
let flow: ConnectFlow;

beforeEach(async () => {
	db = createDb({ url: ":memory:" });
	await migrate(db);
	deployment = fakeDeployment({ name: "Hope Shelter" });
	const app = createApp({ env, db, fetch: deployment.fetch });
	call = async (req) => app.request(req);
	flow = connectFlow(call, deployment, BASE);
	await warmUp(call);
	return () => db.close();
});

afterEach(() => {
	vi.restoreAllMocks();
});

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

test("/mcp refuses a browser request from another site before asking it to sign in", async () => {
	const res = await call(
		mcpPost(INITIALIZE, undefined, { origin: "https://evil.example" }),
	);

	expect(res.status).toBe(403);
	expect(res.headers.get("www-authenticate")).toBeNull();
});

test("/mcp serves a signed-in request that names this site as its origin", async () => {
	const bearer = `Bearer ${(await flow.connect()).access_token}`;

	const res = await call(mcpPost(INITIALIZE, bearer, { origin: BASE }));

	expect(res.status).toBe(200);
});

test("a signed-in chat app initializes and lists tools, told whose site it acts on", async () => {
	const { access_token } = await flow.connect();
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
	expect(
		(await rpc(listed)).result.tools.map((t: { name: string }) => t.name),
	).toContain("list_campaigns");
});

const count = async (table: string) =>
	(await db.execute(`SELECT count(*) AS n FROM "${table}"`)).rows[0]?.n;

test("a bearer whose connection row is gone asks the chat app to sign in again, and its refresh fails", async () => {
	const at = await flow.toReturn();
	const tokens = await flow.finish(at);
	const bearer = `Bearer ${tokens.access_token}`;
	const { rows } = await db.execute("SELECT user_id FROM connection");
	await connections(db, env.CONNECTION_KEY_SECRET).delete(
		String(rows[0]?.user_id),
	);

	expectSignInChallenge(await call(mcpPost(INITIALIZE, bearer)));
	const refreshed = await refresh(
		call,
		at.chat.ep,
		at.chat.a.clientId,
		tokens.refresh_token,
	);
	expect(refreshed.status).toBe(400);
	expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
});

test("a deploy under another connection-key secret answers 500 and keeps the connection", async () => {
	const bearer = `Bearer ${(await flow.connect()).access_token}`;
	const lines = vi.spyOn(console, "error").mockImplementation(() => {});
	const rotated = createApp({
		env: {
			...env,
			CONNECTION_KEY_SECRET: "another-connection-key-secret-bbbbbbbb",
		},
		db,
		fetch: deployment.fetch,
	});

	const res = await rotated.request(mcpPost(INITIALIZE, bearer));

	expect(res.status).toBe(500);
	expect(lines.mock.calls).toEqual([
		[
			JSON.stringify({
				kind: "error",
				where: "app",
				errorName: "ConnectionKeySecretMismatch",
			}),
		],
	]);
	expect([await count("connection"), await count("oauthAccessToken")]).toEqual([
		1, 1,
	]);
	const fixed = await call(mcpPost(INITIALIZE, bearer));
	expect(fixed.status).toBe(200);
	expect((await rpc(fixed)).result.instructions).toContain("Hope Shelter");
});

test("a stored key that can't be decrypted under the right secret drops the connection and refuses its bearer", async () => {
	const bearer = `Bearer ${(await flow.connect()).access_token}`;
	await db.execute("UPDATE connection SET key_ct = key_ct || 'AA'");

	const res = await call(mcpPost(INITIALIZE, bearer));

	expectSignInChallenge(res);
	expect([await count("connection"), await count("oauthAccessToken")]).toEqual([
		0, 0,
	]);
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
	const app = createApp({ env, db: failingDb, fetch: deployment.fetch });
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
