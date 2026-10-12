import { beforeEach, expect, test } from "vitest";
import {
	type FakeDeployment,
	fakeDeployment,
} from "../../test/fake-deployment";
import { mcpRequest, rpc } from "../../test/harness";
import { freshDb } from "../../test/support";
import { connections, type Db } from "../db";
import { deploymentClient } from "../deployment";
import type { Secret } from "../secret";
import { mcpRoute } from "./index";

// mcpRoute on its own: the real tools, a stub for who is signed in. The whole
// service, OAuth included, is test/tools.test.ts's.

const USER = "user_1";

let db: Db;
let deployment: FakeDeployment;
let key: Secret;
let signedInAs: string | null;
let dropped: string[];
let route: ReturnType<typeof mcpRoute>;

beforeEach(async () => {
	db = await freshDb();
	deployment = fakeDeployment({ name: "Give Example" });
	const client = deploymentClient({ fetch: deployment.fetch });
	key = await client.exchange(deployment.origin, deployment.mintCode());
	const store = connections(db, "test-connection-key-secret-aaaaaaaaaaaa");
	await store.insert({
		userId: USER,
		origin: deployment.origin,
		orgName: "Give Example",
		key,
	});
	signedInAs = USER;
	dropped = [];
	route = mcpRoute({
		auth: {
			authenticateMcp: async () =>
				signedInAs === null ? null : { userId: signedInAs },
			dropConnection: async (userId) => {
				dropped.push(userId);
			},
		},
		connections: store,
		client,
		resource: new URL("https://connect.example/mcp"),
	});
	return () => db.close();
});

// The route answers at its own root; app.ts mounts it at /mcp.
const send = (method: string, params?: Record<string, unknown>) =>
	route.request(
		new Request(
			"https://connect.example/",
			mcpRequest("2025-06-18", "Bearer any", method, params),
		),
	);

test("a tool call runs its action on the connection's deployment with its key", async () => {
	const res = await send("tools/call", {
		name: "list_campaigns",
		arguments: { status: "draft" },
	});

	const { result } = await rpc(res);
	expect(JSON.parse(result.content[0].text)).toEqual({
		data: [],
		next_cursor: null,
	});
	expect(deployment.calls.at(-1)).toMatchObject({
		path: "/connector/v1/campaigns",
		query: { status: "draft" },
		authorization: `Bearer ${key.reveal()}`,
	});
});

test("a refused key drops the signed-in user's connection and nobody else's", async () => {
	deployment.refuseKeys();

	const res = await send("tools/call", { name: "list_campaigns" });

	expect((await rpc(res)).result.isError).toBe(true);
	expect(dropped).toEqual([USER]);
});

test("a signed-in user with no connection is asked to sign in again and the leftovers are dropped", async () => {
	signedInAs = "user_without_a_row";

	const res = await send("tools/list");

	expect(res.status).toBe(401);
	expect(res.headers.get("www-authenticate")).toContain(
		'resource_metadata="https://connect.example/.well-known/oauth-protected-resource/mcp"',
	);
	expect(dropped).toEqual(["user_without_a_row"]);
	expect(deployment.calls).toHaveLength(1);
});

test("no signed-in user is asked to sign in and nothing is dropped", async () => {
	signedInAs = null;

	const res = await send("tools/list");

	expect(res.status).toBe(401);
	expect(dropped).toEqual([]);
});
