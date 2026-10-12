import { beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import {
	type FakeDeployment,
	fakeDeployment,
} from "../../test/fake-deployment";
import { connections, createDb, type Db } from "../db";
import { migrate } from "../db/migrate";
import { deploymentClient } from "../deployment";
import type { Secret } from "../secret";
import type { ActionSpec } from "./actions";
import { mcpRoute } from "./index";

vi.mock(import("./actions"), () => ({
	ACTIONS: [
		{
			tool: "list_campaigns",
			action: "campaigns.list",
			title: "List campaigns",
			description: "Lists the site's campaigns.",
			input: z.object({ status: z.string().optional() }),
			annotations: { readOnlyHint: true },
		} satisfies ActionSpec<"list_campaigns">,
	],
}));

const USER = "user_1";

let db: Db;
let deployment: FakeDeployment;
let key: Secret;
let route: ReturnType<typeof mcpRoute>;

beforeEach(async () => {
	db = createDb({ url: ":memory:" });
	await migrate(db);
	deployment = fakeDeployment();
	const client = deploymentClient({ fetch: deployment.fetch });
	key = await client.exchange(deployment.origin, deployment.mintCode());
	const store = connections(db, "test-connection-key-secret-aaaaaaaaaaaa");
	await store.insert({
		userId: USER,
		origin: deployment.origin,
		orgName: "Give Example",
		key,
	});
	route = mcpRoute({
		auth: {
			authenticateMcp: async () => ({ userId: USER }),
			dropConnection: async () => {},
		},
		connections: store,
		client,
		resource: new URL("https://connect.example/mcp"),
	});
	return () => db.close();
});

async function rpc(method: string, params?: unknown) {
	const res = await route.request("https://connect.example/", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const data = (await res.text())
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5))
		.join("");
	return JSON.parse(data).result;
}

test("each action is listed as a tool with its schema and annotations", async () => {
	const { tools } = await rpc("tools/list");

	expect(tools).toMatchObject([
		{
			name: "list_campaigns",
			title: "List campaigns",
			annotations: { readOnlyHint: true },
			inputSchema: { properties: { status: { type: "string" } } },
		},
	]);
});

test("a tool call runs its action on the connection's deployment with its key", async () => {
	const result = await rpc("tools/call", {
		name: "list_campaigns",
		arguments: { status: "draft" },
	});

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
