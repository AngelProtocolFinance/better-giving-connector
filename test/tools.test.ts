import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { createApp } from "../src/app";
import type { Db } from "../src/db";
import { MAX_NOTE } from "../src/mcp/actions";
import {
	ALL_ACTIONS,
	type FakeDeployment,
	fakeDeployment,
	fakeNetwork,
} from "./fake-deployment";
import {
	BASE,
	env,
	MCP_VERSIONS,
	type McpVersion,
	mcpOpen,
	mcpRequest,
	rpc,
	warmUp,
} from "./harness";
import type { Call } from "./oauth";
import { connectFlow } from "./operator";
import {
	connectionRows,
	failingDb,
	freshDb,
	NO_CONNECTION_ROWS,
	StoreDown,
} from "./support";

let db: Db;
let deployment: FakeDeployment;
let call: Call;
let bearer: string;

beforeEach(async () => {
	db = await freshDb();
	deployment = fakeDeployment({ name: "Hope Shelter" });
	// where the site moves to in the "moved" tests; hello there confirms it
	const www = fakeDeployment({
		host: "www.hopeshelter.org",
		name: "Hope Shelter",
	});
	const app = createApp({ env, db, fetch: fakeNetwork(deployment, www) });
	call = async (req) => app.request(req);
	await warmUp(call);
	bearer = `Bearer ${(await connectFlow(call, deployment, BASE).connect()).access_token}`;
	return () => db.close();
});

afterEach(() => {
	vi.restoreAllMocks();
});

let version: McpVersion;
let rpcId = 0;
const send = (method: string, params?: Record<string, unknown>) =>
	call(mcpRequest(version, bearer, method, params, ++rpcId));

const listTools = async () =>
	(await rpc(await send("tools/list"))).result.tools;

const tool = async (name: string, args: Record<string, unknown> = {}) =>
	(await rpc(await send("tools/call", { name, arguments: args }))).result;

const textOf = (result: { content: { text: string }[] }) =>
	result.content.map((c) => c.text).join("\n");

// The deployment's JSON a successful tool call answers with.
const json = (result: { content: { text: string }[] }) =>
	JSON.parse(textOf(result));

describe.each(MCP_VERSIONS)("over MCP %s", (v) => {
	beforeAll(() => {
		version = v;
	});

	const READ = {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	};
	const ADD = {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	};
	const SET = {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	};
	const DESTRUCTIVE = {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	};

	test("tools/list offers one tool per action, each with its annotations", async () => {
		const tools = await listTools();

		expect(
			Object.fromEntries(
				tools.map((t: { name: string; annotations: unknown }) => [
					t.name,
					t.annotations,
				]),
			),
		).toEqual({
			list_campaigns: READ,
			get_campaign: READ,
			create_campaign: { ...ADD, idempotentHint: true },
			update_campaign_blocks: DESTRUCTIVE,
			update_campaign_settings: SET,
			publish_campaign: DESTRUCTIVE,
			unpublish_campaign: DESTRUCTIVE,
			end_campaign: DESTRUCTIVE,
			get_donation_page: READ,
			update_donation_page_blocks: DESTRUCTIVE,
			reset_donation_page: DESTRUCTIVE,
			get_block_catalog: READ,
			list_forms: READ,
			get_form: READ,
			create_form: ADD,
			update_form: SET,
			get_results: READ,
			list_donations: READ,
			list_donors: READ,
			get_donor: READ,
			list_recurring_gifts: READ,
			record_donation: { ...ADD, idempotentHint: true },
			create_photo_upload_link: ADD,
		});
	});

	test("publish, unpublish, end, reset, and whole-page block replacement are destructive", async () => {
		const tools: {
			name: string;
			annotations: { destructiveHint?: boolean; readOnlyHint?: boolean };
		}[] = await listTools();
		const byName = new Map(tools.map((t) => [t.name, t.annotations]));

		for (const name of [
			"publish_campaign",
			"unpublish_campaign",
			"end_campaign",
			"reset_donation_page",
			"update_campaign_blocks",
			"update_donation_page_blocks",
		]) {
			expect(byName.get(name)).toMatchObject({
				readOnlyHint: false,
				destructiveHint: true,
			});
		}
	});

	test("each tool's input schema requires what its contract body needs", async () => {
		const tools: { name: string; inputSchema: { required?: string[] } }[] =
			await listTools();

		expect(
			Object.fromEntries(
				tools.map((t) => [t.name, (t.inputSchema.required ?? []).toSorted()]),
			),
		).toEqual({
			list_campaigns: [],
			get_campaign: ["id"],
			create_campaign: ["title"],
			update_campaign_blocks: ["blocks", "id"],
			update_campaign_settings: ["id"],
			publish_campaign: ["id"],
			unpublish_campaign: ["id"],
			end_campaign: ["id"],
			get_donation_page: [],
			update_donation_page_blocks: ["blocks"],
			reset_donation_page: ["confirm"],
			get_block_catalog: [],
			list_forms: [],
			get_form: ["id"],
			create_form: ["name"],
			update_form: ["id"],
			get_results: [],
			list_donations: [],
			list_donors: [],
			get_donor: ["id"],
			list_recurring_gifts: [],
			record_donation: ["amount", "date", "donor", "method"],
			create_photo_upload_link: ["target"],
		});
	});

	test("record_donation offers only the contract's payment methods", async () => {
		const tools = await listTools();
		const record = tools.find(
			(t: { name: string }) => t.name === "record_donation",
		);

		expect(record.inputSchema.properties.method.enum).toEqual([
			"cash",
			"check",
		]);
		expect(record.inputSchema.properties).not.toHaveProperty("campaign_id");
	});

	test("the tools that change what donors see say the operator confirms first", async () => {
		const tools: { name: string; description: string }[] = await listTools();

		const asking = tools
			.filter((t) =>
				/operator confirms it in the chat first/.test(t.description),
			)
			.map((t) => t.name);

		expect(asking).toEqual([
			"publish_campaign",
			"unpublish_campaign",
			"end_campaign",
			"reset_donation_page",
		]);
	});

	test("record_donation says it records an offline gift and moves no money", async () => {
		const tools: { name: string; description: string }[] = await listTools();
		const { description } =
			tools.find((t) => t.name === "record_donation") ?? {};

		expect(description).toMatch(/offline/i);
		expect(description).toMatch(/moves no money/i);
		expect(description).toMatch(/issues no refund/i);
	});

	test.each([
		["update_campaign_blocks", "get_campaign"],
		["update_donation_page_blocks", "get_donation_page"],
	])(
		"%s describes a full block replacement using %s and the catalog",
		async (name, read) => {
			const tools: { name: string; description: string }[] = await listTools();

			const { description } = tools.find((t) => t.name === name) ?? {};

			expect(description).toContain("A block left out is deleted");
			expect(description).toContain(read);
			expect(description).toContain("get_block_catalog");
		},
	);

	const SECRET_FIELDS = [
		"key",
		"connection_key",
		"connector_key",
		"secret",
		"password",
		"access_token",
		"refresh_token",
		"authorization",
		"client_secret",
		"api_key",
		"bearer",
	];

	function propertyNames(schema: unknown, out: string[] = []): string[] {
		if (typeof schema !== "object" || schema === null) return out;
		const record = schema as {
			properties?: Record<string, unknown>;
			items?: unknown;
			anyOf?: unknown[];
			oneOf?: unknown[];
		};
		if (record.properties) {
			for (const [name, child] of Object.entries(record.properties)) {
				out.push(name);
				propertyNames(child, out);
			}
		}
		if (record.items) propertyNames(record.items, out);
		for (const list of [record.anyOf, record.oneOf]) {
			if (!list) continue;
			for (const child of list) propertyNames(child, out);
		}
		return out;
	}

	test("no tool input schema has a connection key or other secret field", async () => {
		const tools: { name: string; inputSchema: unknown }[] = await listTools();

		const found = tools.flatMap((t) =>
			propertyNames(t.inputSchema)
				.filter((name) => SECRET_FIELDS.includes(name))
				.map((name) => `${t.name}.${name}`),
		);

		expect(found).toEqual([]);
	});

	test("a deployment answer that echoes the connection key is returned without it", async () => {
		const key = deployment.issuedKeys[0] ?? "";
		expect(key).not.toBe("");
		deployment.intercept(() =>
			Response.json({
				id: "cmp_x",
				echo: key,
				nested: { note: `prefix ${key} suffix` },
			}),
		);

		const text = textOf(await tool("get_campaign", { id: "cmp_x" }));

		expect(text).not.toContain(key);
		expect(JSON.parse(text)).toEqual({
			id: "cmp_x",
			echo: "[redacted]",
			nested: { note: "prefix [redacted] suffix" },
		});
	});

	test("a problem detail that echoes the connection key is returned without it", async () => {
		const key = deployment.issuedKeys[0] ?? "";
		expect(key).not.toBe("");
		deployment.intercept(() =>
			Response.json(
				{ code: "validation_failed", detail: `saw ${key} and ${key}` },
				{
					status: 422,
					headers: { "content-type": "application/problem+json" },
				},
			),
		);

		const text = textOf(await tool("get_campaign", { id: "cmp_x" }));

		expect(text).not.toContain(key);
		expect(text).toContain("saw [redacted] and [redacted]");
	});

	const GIFT = {
		amount: { amount: "40.00", currency: "USD" },
		date: "2026-10-01",
		donor: { name: "Ada Park", email: "ada@example.org" },
		method: "check",
	};

	// A campaign and a donor on the fake, made through the tools themselves.
	async function seed() {
		const campaign = json(
			await tool("create_campaign", { title: "Winter coats" }),
		);
		const gift = json(await tool("record_donation", GIFT));
		return {
			campaignId: campaign.id as string,
			donorId: gift.donor_id as string,
		};
	}

	type Ids = Awaited<ReturnType<typeof seed>>;

	test.each<
		[
			string,
			(ids: Ids) => Record<string, unknown>,
			string,
			(ids: Ids) => string,
		]
	>([
		[
			"list_campaigns",
			() => ({ status: "draft", limit: 10 }),
			"GET",
			() => "/campaigns",
		],
		[
			"get_campaign",
			(i) => ({ id: i.campaignId }),
			"GET",
			(i) => `/campaigns/${i.campaignId}`,
		],
		[
			"create_campaign",
			() => ({ title: "Spring drive" }),
			"POST",
			() => "/campaigns",
		],
		[
			"update_campaign_blocks",
			(i) => ({
				id: i.campaignId,
				blocks: [{ type: "text", body: "Thank you" }],
			}),
			"PATCH",
			(i) => `/campaigns/${i.campaignId}/blocks`,
		],
		[
			"update_campaign_settings",
			(i) => ({
				id: i.campaignId,
				goal: { amount: "5000.00", currency: "USD" },
				end_date: "2026-12-31",
			}),
			"PATCH",
			(i) => `/campaigns/${i.campaignId}/settings`,
		],
		[
			"publish_campaign",
			(i) => ({ id: i.campaignId, gifts_go_to: null }),
			"POST",
			(i) => `/campaigns/${i.campaignId}/publish`,
		],
		[
			"end_campaign",
			(i) => ({ id: i.campaignId }),
			"POST",
			(i) => `/campaigns/${i.campaignId}/end`,
		],
		["get_donation_page", () => ({}), "GET", () => "/donation-page"],
		[
			"update_donation_page_blocks",
			() => ({ blocks: [{ type: "hero", heading: "Give today" }] }),
			"PATCH",
			() => "/donation-page/blocks",
		],
		[
			"reset_donation_page",
			() => ({ confirm: true }),
			"POST",
			() => "/donation-page/reset",
		],
		["get_block_catalog", () => ({}), "GET", () => "/blocks/catalog"],
		["list_forms", () => ({}), "GET", () => "/forms"],
		["get_form", () => ({ id: "frm_1" }), "GET", () => "/forms/frm_1"],
		[
			"create_form",
			() => ({ name: "Gala", allow_recurring: false }),
			"POST",
			() => "/forms",
		],
		[
			"update_form",
			() => ({ id: "frm_1", name: "Main form" }),
			"PATCH",
			() => "/forms/frm_1",
		],
		[
			"get_results",
			(i) => ({ campaign_id: i.campaignId, from: "2026-01-01" }),
			"GET",
			() => "/results",
		],
		["list_donations", () => ({ to: "2026-12-31" }), "GET", () => "/donations"],
		["list_donors", () => ({ q: "ada" }), "GET", () => "/donors"],
		[
			"get_donor",
			(i) => ({ id: i.donorId }),
			"GET",
			(i) => `/donors/${i.donorId}`,
		],
		["list_recurring_gifts", () => ({}), "GET", () => "/recurring"],
		["record_donation", () => GIFT, "POST", () => "/donations"],
		[
			"create_photo_upload_link",
			(i) => ({ target: { kind: "campaign", id: i.campaignId } }),
			"POST",
			() => "/photos/upload-link",
		],
	])(
		"%s runs its contract route with the connection's key",
		async (name, args, method, path) => {
			const ids = await seed();

			const result = await tool(name, args(ids));

			expect(result.isError).toBeUndefined();
			expect(deployment.calls.at(-1)).toMatchObject({
				method,
				path: `/connector/v1${path(ids)}`,
				authorization: `Bearer ${deployment.issuedKeys[0]}`,
			});
		},
	);

	test("unpublish_campaign runs its contract route on a published campaign", async () => {
		const { campaignId } = await seed();
		await tool("publish_campaign", { id: campaignId, gifts_go_to: null });

		const result = await tool("unpublish_campaign", { id: campaignId });

		expect(json(result)).toMatchObject({ id: campaignId, status: "draft" });
		expect(deployment.calls.at(-1)).toMatchObject({
			method: "POST",
			path: `/connector/v1/campaigns/${campaignId}/unpublish`,
		});
	});

	test("a tool answers with the deployment's JSON once, as text", async () => {
		const answer = {
			data: [{ id: "cmp_9", title: "Roof fund" }],
			next_cursor: "25",
		};
		deployment.intercept(() => Response.json(answer));

		const result = await tool("list_campaigns");

		expect(result.structuredContent).toBeUndefined();
		expect(result.content).toHaveLength(1);
		expect(json(result)).toEqual(answer);
	});

	test("query and body carry the tool's arguments, path ids excepted", async () => {
		const { campaignId } = await seed();

		await tool("list_campaigns", { status: "draft", limit: 10 });
		const listed = deployment.calls.at(-1);
		await tool("update_campaign_settings", {
			id: campaignId,
			end_date: "2026-12-31",
		});
		const updated = deployment.calls.at(-1);

		expect(listed?.query).toEqual({ status: "draft", limit: "10" });
		expect(updated?.body).toEqual({ end_date: "2026-12-31" });
	});

	test.each<[string, Record<string, unknown>]>([
		["get_campaign", { id: ".." }],
		["get_campaign", { id: "." }],
		["publish_campaign", { id: "cmp_1/../../donation-page/reset" }],
		["update_form", { id: "frm_1/x", name: "Main form" }],
		["get_results", { campaign_id: "a/b" }],
		["create_photo_upload_link", { target: { kind: "campaign", id: ".." } }],
	])("%s refuses the id in %j before any request", async (name, args) => {
		const before = deployment.calls.length;

		const result = await tool(name, args);

		expect(result.isError).toBe(true);
		expect(deployment.calls.length).toBe(before);
	});

	// A call each tool accepts, and the same call with one thing wrong in it.
	const ACCEPTED: Record<string, Record<string, unknown>> = {
		list_campaigns: {},
		list_forms: {},
		list_donations: {},
		list_donors: {},
		list_recurring_gifts: {},
		get_results: {},
		get_donation_page: {},
		reset_donation_page: { confirm: true },
		create_campaign: { title: "Spring drive" },
		update_campaign_settings: { id: "cmp_1", end_date: "2026-12-31" },
		record_donation: GIFT,
		create_photo_upload_link: { target: { kind: "donation_page" } },
	};

	test.each(Object.entries(ACCEPTED))(
		"%s with %j reaches the deployment",
		async (name, args) => {
			const before = deployment.calls.length;

			await tool(name, args);

			expect(deployment.calls.length).toBe(before + 1);
		},
	);

	const GIFT_WITH = (changes: Record<string, unknown>) => ({
		...GIFT,
		...changes,
	});
	const USD = (amount: unknown, currency: unknown = "USD") => ({
		amount,
		currency,
	});

	// [tool, what is wrong, the arguments, what the refusal names]
	const REFUSED: [string, string, Record<string, unknown>, string][] = [
		[
			"record_donation",
			"a bare-string amount",
			GIFT_WITH({ amount: "5" }),
			"amount",
		],
		[
			"record_donation",
			"a fraction of a cent",
			GIFT_WITH({ amount: USD("5.001") }),
			"amount.amount",
		],
		[
			"record_donation",
			"a negative amount",
			GIFT_WITH({ amount: USD("-5.00") }),
			"amount.amount",
		],
		[
			"record_donation",
			"a numeric amount",
			GIFT_WITH({ amount: USD(5) }),
			"amount.amount",
		],
		[
			"record_donation",
			"an amount with a comma",
			GIFT_WITH({ amount: USD("1,000.00") }),
			"amount.amount",
		],
		[
			"record_donation",
			"another currency",
			GIFT_WITH({ amount: USD("5.00", "EUR") }),
			"amount.currency",
		],
		[
			"record_donation",
			"an extra key in the amount",
			GIFT_WITH({ amount: { ...USD("5.00"), tax: "1" } }),
			"Unrecognized key",
		],
		[
			"record_donation",
			"a date in words",
			GIFT_WITH({ date: "yesterday" }),
			"date",
		],
		[
			"record_donation",
			"a date that isn't on the calendar",
			GIFT_WITH({ date: "2026-02-30" }),
			"date",
		],
		[
			"record_donation",
			"a date without zero padding",
			GIFT_WITH({ date: "2026-1-1" }),
			"date",
		],
		[
			"record_donation",
			"a timestamp for a date",
			GIFT_WITH({ date: "2026-10-01T00:00:00Z" }),
			"date",
		],
		[
			"record_donation",
			"a donor email that isn't one",
			GIFT_WITH({ donor: { name: "Ada", email: "ada" } }),
			"donor.email",
		],
		[
			"record_donation",
			"a blank donor name",
			GIFT_WITH({ donor: { name: "  " } }),
			"donor.name",
		],
		[
			"record_donation",
			"an extra key on the donor",
			GIFT_WITH({ donor: { name: "Ada", phone: "555" } }),
			"Unrecognized key",
		],
		[
			"record_donation",
			"an extra key",
			GIFT_WITH({ tip: "5.00" }),
			"Unrecognized key",
		],
		[
			"record_donation",
			"a method outside the contract's",
			GIFT_WITH({ method: "venmo" }),
			"method",
		],
		[
			"record_donation",
			"a method in capitals",
			GIFT_WITH({ method: "Cash" }),
			"method",
		],
		[
			"list_campaigns",
			"a status no campaign has",
			{ status: "archived" },
			"status",
		],
		["list_campaigns", "a limit of 101", { limit: 101 }, "limit"],
		["list_campaigns", "a limit of 0", { limit: 0 }, "limit"],
		["list_campaigns", "a fractional limit", { limit: 1.5 }, "limit"],
		["list_campaigns", "a limit in quotes", { limit: "10" }, "limit"],
		["list_campaigns", "a cursor that is a number", { cursor: 25 }, "cursor"],
		["list_campaigns", "an extra key", { page: 2 }, "Unrecognized key"],
		["list_forms", "a limit of 101", { limit: 101 }, "limit"],
		["list_donations", "a limit of 101", { limit: 101 }, "limit"],
		["list_donations", "a from date in words", { from: "last spring" }, "from"],
		[
			"list_donations",
			"a to date past the month's end",
			{ to: "2026-04-31" },
			"to",
		],
		["list_donors", "a limit of 101", { limit: 101 }, "limit"],
		["list_donors", "a query that is a number", { q: 5 }, "q"],
		["list_recurring_gifts", "a limit of 101", { limit: 101 }, "limit"],
		["get_results", "a from date in words", { from: "2026" }, "from"],
		["get_results", "an extra key", { year: 2026 }, "Unrecognized key"],
		["create_campaign", "a blank title", { title: "   " }, "title"],
		["create_campaign", "a title that is a number", { title: 7 }, "title"],
		[
			"create_campaign",
			"an extra key",
			{ title: "Spring drive", draft: false },
			"Unrecognized key",
		],
		[
			"update_campaign_settings",
			"an end date in words",
			{ id: "cmp_1", end_date: "next year" },
			"end_date",
		],
		[
			"update_campaign_settings",
			"a goal with a bad amount",
			{ id: "cmp_1", goal: USD("5k") },
			"goal.amount",
		],
		[
			"update_campaign_settings",
			"a goal in another currency",
			{ id: "cmp_1", goal: USD("50.00", "GBP") },
			"goal.currency",
		],
		[
			"update_campaign_settings",
			"an extra key in sharing",
			{ id: "cmp_1", sharing: { image: "x" } },
			"Unrecognized key",
		],
		[
			"update_campaign_settings",
			"an extra key",
			{ id: "cmp_1", status: "published" },
			"Unrecognized key",
		],
		[
			"create_photo_upload_link",
			"a target kind it doesn't know",
			{ target: { kind: "form" } },
			"target",
		],
		[
			"create_photo_upload_link",
			"an id on the donation page target",
			{ target: { kind: "donation_page", id: "x" } },
			"Unrecognized key",
		],
		[
			"create_photo_upload_link",
			"a slot that is a number",
			{ target: { kind: "donation_page" }, slot: 3 },
			"slot",
		],
		[
			"get_donation_page",
			"an extra key",
			{ campaign_id: "cmp_1" },
			"Unrecognized key",
		],
		[
			"reset_donation_page",
			"an extra key",
			{ confirm: true, again: true },
			"Unrecognized key",
		],
		["reset_donation_page", "confirm left out", {}, "confirm"],
	];

	test.each(REFUSED)(
		"%s with %s is refused before any request",
		async (name, _, args, names) => {
			const before = deployment.calls.length;

			const result = await tool(name, args);

			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain(`Invalid arguments for tool ${name}`);
			expect(textOf(result)).toContain(names);
			expect(deployment.calls.length).toBe(before);
		},
	);

	test("every tool with a refusal above also has an accepted call", () => {
		const refused = new Set(REFUSED.map(([name]) => name));

		expect([...refused].filter((name) => !(name in ACCEPTED))).toEqual([]);
	});

	test("an id with dots inside it still reaches the deployment", async () => {
		await tool("get_campaign", { id: "cmp.1..2" });

		expect(deployment.calls.at(-1)?.path).toBe(
			"/connector/v1/campaigns/cmp.1..2",
		);
	});

	const connectionCount = async () =>
		(await db.execute("SELECT count(*) AS n FROM connection")).rows[0]?.n;

	test("a refused key answers reconnect, drops the connection and signs the chat app out", async () => {
		deployment.refuseKeys();

		const result = await tool("list_campaigns");

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(
			"Better Giving at Hope Shelter no longer accepts this connection. Reconnect Better Giving in your AI assistant's connector settings to keep going.",
		);
		expect(await connectionRows(db)).toEqual(NO_CONNECTION_ROWS);
		const next = await send("tools/list");
		expect(next.status).toBe(401);
		expect(next.headers.get("www-authenticate")).toContain(
			`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
		);
	});

	test("a site that moved to another address answers reconnect at the new address and drops the connection", async () => {
		deployment.intercept(() =>
			Response.redirect(
				"https://www.hopeshelter.org/connector/v1/campaigns",
				301,
			),
		);

		const result = await tool("list_campaigns");

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(
			"Hope Shelter's Better Giving site has moved to a new address. Reconnect Better Giving in your AI assistant's connector settings and type the new address.",
		);
		expect(await connectionRows(db)).toEqual(NO_CONNECTION_ROWS);
		expect((await send("tools/list")).status).toBe(401);
	});

	test("a temporary redirect to another address keeps the connection", async () => {
		deployment.intercept(() =>
			Response.redirect(
				"https://www.hopeshelter.org/connector/v1/campaigns",
				302,
			),
		);

		const result = await tool("list_campaigns");

		expect(result.isError).toBe(true);
		expect(textOf(result)).not.toContain("moved");
		expect(await connectionRows(db)).not.toEqual(NO_CONNECTION_ROWS);
		expect((await send("tools/list")).status).toBe(200);
	});

	test("a release without an action answers update for that tool while others work", async () => {
		deployment.setActions(
			ALL_ACTIONS.filter((a) => a !== "photos.upload_link"),
		);

		const missing = await tool("create_photo_upload_link", {
			target: { kind: "donation_page" },
		});
		const present = await tool("get_donation_page");

		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toBe(
			"Hope Shelter can't do this through the connector yet. The other tools still work.",
		);
		expect(present.isError).toBeUndefined();
		expect(await connectionCount()).toBe(1);
	});

	test("a missing resource answers with the deployment's problem", async () => {
		const result = await tool("get_campaign", { id: "cmp_404" });

		expect(result.isError).toBe(true);
		expect(JSON.parse(textOf(result))).toEqual({
			title: "not_found",
			detail: "No campaign has that id.",
			code: "not_found",
		});
	});

	test("a body the deployment refuses answers with its field errors", async () => {
		const { campaignId } = await seed();

		const result = await tool("update_campaign_blocks", {
			id: campaignId,
			blocks: [{ type: "carousel" }],
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(textOf(result))).toEqual({
			title: "validation_failed",
			detail: "The request body is invalid.",
			code: "validation_failed",
			errors: [{ path: "blocks.0.type", message: "unknown block type" }],
		});
	});

	test.each([
		["an HTML page", () => new Response("<h1>Forbidden</h1>", { status: 403 })],
		[
			"JSON that isn't a problem",
			() => Response.json({ ok: false }, { status: 403 }),
		],
	])(
		"a refusal carrying %s answers that the site refused",
		async (_, answer) => {
			deployment.intercept(answer);

			const result = await tool("get_donation_page");

			expect(result.isError).toBe(true);
			expect(textOf(result)).toBe(
				"Hope Shelter's Better Giving refused this request.",
			);
		},
	);

	test("a site that doesn't answer usably says so", async () => {
		deployment.intercept(() => new Response("upstream down", { status: 502 }));

		const result = await tool("list_campaigns");

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(
			"Hope Shelter's donation site didn't answer. Try again in a moment.",
		);
	});

	// This service again, over the same database, where dropping a connection fails.
	async function serveWithFailingDrop() {
		const failing = failingDb(db);
		failing.failOn(
			/^DELETE FROM connection/,
			new StoreDown("sentinel-store-detail"),
		);
		const app = createApp({ env, db: failing.db, fetch: deployment.fetch });
		call = async (req) => app.request(req);
		await warmUp(call);
	}

	// Every line written to the console while `run` runs: console.log's, then console.error's.
	async function linesDuring(run: () => Promise<unknown>) {
		const out = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		await run();
		return [...out.mock.calls, ...err.mock.calls].map(([line]) => String(line));
	}

	test("an unexpected failure answers a generic sentence, not its message", async () => {
		await serveWithFailingDrop();
		deployment.refuseKeys();
		let result: { isError?: boolean; content: { text: string }[] } | undefined;

		await linesDuring(async () => {
			result = await tool("list_campaigns");
		});

		expect(result?.isError).toBe(true);
		expect(textOf(result ?? { content: [] })).toBe(
			"Something went wrong on Better Giving's side. Try again in a moment.",
		);
	});

	const SENTINEL = "sentinel-donor-7c1e";

	test("a tool call logs one line holding no argument, result or key", async () => {
		let result: { content: { text: string }[] } | undefined;

		const lines = await linesDuring(async () => {
			result = await tool("record_donation", {
				...GIFT,
				donor: { name: SENTINEL },
				note: `${SENTINEL}-note`,
			});
		});

		expect(textOf(result ?? { content: [] })).toContain(`${SENTINEL}-note`);
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{
				kind: "tool",
				tool: "donations.record",
				outcome: "ok",
				ms: expect.any(Number),
			},
		]);
		const written = lines.join("\n");
		expect(written).not.toContain(SENTINEL);
		expect(written).not.toContain("40.00");
		expect(written).not.toContain(deployment.issuedKeys[0]);
	});

	test.each<[string, () => void, string]>([
		["a refused key", () => deployment.refuseKeys(), "key_refused"],
		["a missing action", () => deployment.setActions([]), "needs_update"],
		[
			"a rejection",
			() =>
				deployment.intercept(() =>
					Response.json(
						{ code: "invalid_state", detail: SENTINEL },
						{ status: 409 },
					),
				),
			"rejected",
		],
		[
			"a silent site",
			() => deployment.intercept(() => new Response(null, { status: 503 })),
			"unreachable",
		],
	])(
		"%s logs its outcome and nothing of the answer",
		async (_, arrange, outcome) => {
			arrange();

			const lines = await linesDuring(() => tool("get_donation_page"));

			expect(lines.map((line) => JSON.parse(line))).toEqual([
				{
					kind: "tool",
					tool: "donation_page.get",
					outcome,
					ms: expect.any(Number),
				},
			]);
			expect(lines.join("\n")).not.toContain(SENTINEL);
		},
	);

	test("a tool call refused on its input logs an invalid_input line holding none of it", async () => {
		let result: { isError?: boolean } | undefined;
		const before = deployment.calls.length;

		const lines = await linesDuring(async () => {
			result = await tool("record_donation", {
				...GIFT,
				donor: { name: SENTINEL },
				date: "yesterday",
			});
		});

		expect(result?.isError).toBe(true);
		expect(deployment.calls.length).toBe(before);
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{
				kind: "tool",
				tool: "donations.record",
				outcome: "invalid_input",
				ms: expect.any(Number),
			},
		]);
		expect(lines.join("\n")).not.toContain(SENTINEL);
	});

	test("a request the MCP handler rejects logs an error line naming only the error", async () => {
		const lines = await linesDuring(async () => {
			const res = await call(
				new Request(`${BASE}/mcp`, {
					method: "POST",
					headers: { authorization: bearer, "content-type": "text/plain" },
					body: SENTINEL,
				}),
			);
			expect(res.status).toBe(415);
		});

		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{ kind: "error", where: "mcp", errorName: "Error" },
		]);
	});

	test("an unexpected failure logs a failed tool line beside its error line", async () => {
		await serveWithFailingDrop();
		deployment.refuseKeys();

		const lines = await linesDuring(() => tool("list_campaigns"));

		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{
				kind: "tool",
				tool: "campaigns.list",
				outcome: "failed",
				ms: expect.any(Number),
			},
			{ kind: "error", where: "mcp", errorName: "StoreDown" },
		]);
	});

	test("the server answers in the protocol version it was asked in", async () => {
		const { result } = await rpc(await call(mcpOpen(version, bearer)));

		expect(
			version === "2025-06-18"
				? result.protocolVersion
				: result.supportedVersions,
		).toEqual(version === "2025-06-18" ? version : [version]);
	});

	test("the server's instructions name every tool that waits for a yes", async () => {
		const res = await call(mcpOpen(version, bearer));
		const { instructions } = (await rpc(res)).result;

		const waiting = instructions.match(
			/Before (.+), say what will change/,
		)?.[1];

		expect(waiting).toBe(
			"publish_campaign, unpublish_campaign, end_campaign or reset_donation_page",
		);
	});

	const unconfirmed = (check: string) =>
		`Hope Shelter's donation site didn't confirm this. It may have gone through. Check with ${check} before trying again.`;

	test.each<[string, string, Record<string, unknown>]>([
		["create_campaign", "list_campaigns", { title: "Spring drive" }],
		["update_campaign_blocks", "get_campaign", { id: "cmp_1", blocks: [] }],
		[
			"update_campaign_settings",
			"get_campaign",
			{ id: "cmp_1", end_date: "2026-12-31" },
		],
		["publish_campaign", "get_campaign", { id: "cmp_1" }],
		["unpublish_campaign", "get_campaign", { id: "cmp_1" }],
		["end_campaign", "get_campaign", { id: "cmp_1" }],
		["update_donation_page_blocks", "get_donation_page", { blocks: [] }],
		["reset_donation_page", "get_donation_page", { confirm: true }],
		["create_form", "list_forms", { name: "Gala" }],
		["update_form", "get_form", { id: "frm_1", name: "Main form" }],
		["record_donation", "list_donations", GIFT],
	])(
		"%s that gets no answer says to check with %s before trying again",
		async (name, check, args) => {
			deployment.intercept(() => new Response(null, { status: 502 }));

			const result = await tool(name, args);

			expect(result.isError).toBe(true);
			expect(textOf(result)).toBe(unconfirmed(check));
		},
	);

	test("an upload link that gets no answer just asks to try again", async () => {
		deployment.intercept(() => new Response(null, { status: 502 }));

		const result = await tool("create_photo_upload_link", {
			target: { kind: "donation_page" },
		});

		expect(textOf(result)).toBe(
			"Hope Shelter's donation site didn't answer. Try again in a moment.",
		);
	});

	test("a write that fails unexpectedly says it may have gone through", async () => {
		await serveWithFailingDrop();
		deployment.refuseKeys();
		let result: { content: { text: string }[] } | undefined;

		await linesDuring(async () => {
			result = await tool("record_donation", GIFT);
		});

		expect(textOf(result ?? { content: [] })).toBe(
			unconfirmed("list_donations"),
		);
	});

	test.each<[string, Record<string, unknown>, Record<string, unknown>]>([
		[
			"create_form",
			{ name: "Gala", amounts: ["50.00", "100.00"], allow_recurring: true },
			{ name: "Gala", amounts: ["50.00", "100.00"], allow_recurring: true },
		],
		[
			"update_form",
			{ id: "frm_1", allow_recurring: false },
			{ allow_recurring: false },
		],
	])(
		"%s sends form fields beyond its schema to the deployment",
		async (name, args, body) => {
			const result = await tool(name, args);

			expect(result.isError).toBeUndefined();
			expect(deployment.calls.at(-1)?.body).toEqual(body);
		},
	);

	const REPLAY =
		"Already done: this matches an earlier call with the same details, so nothing new was recorded. The original result follows.";

	test("recording the same gift again says it was already done, and a note records another", async () => {
		const first = await tool("record_donation", GIFT);
		const replayed = await tool("record_donation", GIFT);
		const noted = await tool("record_donation", {
			...GIFT,
			note: "the second check",
		});

		expect(textOf(first).startsWith("{")).toBe(true);
		expect(textOf(replayed).startsWith(`${REPLAY}\n`)).toBe(true);
		expect(JSON.parse(textOf(replayed).slice(REPLAY.length + 1))).toEqual(
			json(first),
		);
		expect(json(noted)).toMatchObject({ note: "the second check" });
		expect(textOf(noted).startsWith(REPLAY)).toBe(false);
	});

	test("creating the same campaign again says it was already done", async () => {
		const first = await tool("create_campaign", { title: "Winter drive" });
		const replayed = await tool("create_campaign", { title: "Winter drive" });

		expect(textOf(replayed).startsWith(`${REPLAY}\n`)).toBe(true);
		expect(JSON.parse(textOf(replayed).slice(REPLAY.length + 1))).toEqual(
			json(first),
		);
	});

	test("keyed writes send one stable Idempotency-Key and logs leave it out", async () => {
		const lines = await linesDuring(() => tool("record_donation", GIFT));
		const header = deployment.calls.at(-1)?.idempotencyKey ?? "";
		await tool("record_donation", GIFT);

		expect(header).not.toBe("");
		expect(deployment.calls.at(-1)?.idempotencyKey).toBe(header);
		expect(lines.join("\n")).not.toContain(header);
	});

	test("a 409 idempotency conflict is the deployment's problem", async () => {
		deployment.intercept(
			() =>
				new Response(
					JSON.stringify({
						code: "idempotency_conflict",
						detail: "This key already recorded a different gift.",
					}),
					{
						status: 409,
						headers: { "content-type": "application/problem+json" },
					},
				),
		);

		const result = await tool("record_donation", GIFT);

		expect(result.isError).toBe(true);
		expect(JSON.parse(textOf(result))).toMatchObject({
			code: "idempotency_conflict",
		});
	});

	test("a 5xx problem is shown, and a write says to check before trying again", async () => {
		deployment.intercept(
			() =>
				new Response(
					JSON.stringify({
						code: "write_failed",
						detail: "Recording did not complete.",
					}),
					{
						status: 500,
						headers: { "content-type": "application/problem+json" },
					},
				),
		);
		const lines = await linesDuring(async () => {
			const result = await tool("record_donation", GIFT);

			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain('"code":"write_failed"');
			expect(textOf(result)).toContain(
				"It may or may not have been saved; check with list_donations before trying again.",
			);
		});

		expect(lines.map((line) => JSON.parse(line))).toContainEqual(
			expect.objectContaining({
				kind: "tool",
				tool: "donations.record",
				outcome: "server_error",
			}),
		);
	});

	test("a 5xx without a problem body says the site didn't answer", async () => {
		deployment.intercept(() => new Response("upstream", { status: 503 }));

		const result = await tool("get_campaign", { id: "cmp_1" });

		expect(textOf(result)).toBe(
			"Hope Shelter's donation site didn't answer. Try again in a moment.",
		);
	});

	test("list and get campaign point at get_results for the amount raised", async () => {
		const tools: { name: string; description: string }[] = await listTools();

		for (const name of ["list_campaigns", "get_campaign"]) {
			const description = tools.find((t) => t.name === name)?.description ?? "";
			expect(description).toContain("use get_results");
			expect(description).not.toContain("amount raised, and id");
			expect(description).not.toContain("and amount raised");
		}
	});

	test("publish asks the operator where gifts go before the first publish", async () => {
		const tools: {
			name: string;
			description: string;
			inputSchema: { properties: Record<string, { type?: string | string[] }> };
		}[] = await listTools();
		const publish = tools.find((t) => t.name === "publish_campaign");

		expect(publish?.description).toContain("ask the operator");
		expect(publish?.description).toContain("general fund");
		expect(publish?.description).toContain("gifts_go_to");
		expect(publish?.inputSchema.properties.gifts_go_to).toBeDefined();
	});

	test("get_donor pages gifts, and settings take a time zone and sharing message", async () => {
		const tools: {
			name: string;
			inputSchema: { properties: Record<string, unknown> };
		}[] = await listTools();
		const donor = tools.find((t) => t.name === "get_donor");
		const settings = tools.find((t) => t.name === "update_campaign_settings");
		const form = tools.find((t) => t.name === "update_form");

		expect(donor?.inputSchema.properties).toMatchObject({
			cursor: expect.any(Object),
			limit: expect.any(Object),
		});
		expect(settings?.inputSchema.properties).toMatchObject({
			time_zone: expect.any(Object),
			sharing: expect.any(Object),
		});
		expect(form?.inputSchema.properties).toMatchObject({
			confirm: expect.any(Object),
		});
	});

	test("record_donation tells the model to add a note for a second identical gift", async () => {
		const tools: { name: string; description: string }[] = await listTools();
		const description =
			tools.find((t) => t.name === "record_donation")?.description ?? "";

		expect(description).toMatch(/cash or by check/i);
		expect(description).toMatch(/distinguishing note/);
		expect(description).not.toMatch(/bank transfer/i);
	});

	test("publish_campaign leaves gifts_go_to out when the caller does", async () => {
		const { campaignId } = await seed();

		const result = await tool("publish_campaign", { id: campaignId });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("gifts_go_to");
		expect(deployment.calls.at(-1)).toMatchObject({
			method: "POST",
			path: `/connector/v1/campaigns/${campaignId}/publish`,
			body: {},
		});
	});

	test("a later publish omits gifts_go_to, and sending it again is refused", async () => {
		const { campaignId } = await seed();
		expect(
			(await tool("publish_campaign", { id: campaignId, gifts_go_to: null }))
				.isError,
		).toBeUndefined();
		expect(
			(await tool("unpublish_campaign", { id: campaignId })).isError,
		).toBeUndefined();

		const again = await tool("publish_campaign", { id: campaignId });

		expect(again.isError).toBeUndefined();
		expect(deployment.calls.at(-1)?.body).toEqual({});

		expect(
			(await tool("unpublish_campaign", { id: campaignId })).isError,
		).toBeUndefined();
		const restated = await tool("publish_campaign", {
			id: campaignId,
			gifts_go_to: "prog_1",
		});

		expect(restated.isError).toBe(true);
		expect(textOf(restated)).toContain("gifts_go_to");
		expect(deployment.calls.at(-1)?.body).toEqual({ gifts_go_to: "prog_1" });
	});

	test("record_donation sends the note as note and list_donations returns it", async () => {
		const result = await tool("record_donation", {
			...GIFT,
			note: "envelope at the desk",
		});

		expect(deployment.calls.at(-1)?.body).toEqual({
			...GIFT,
			note: "envelope at the desk",
		});
		expect(deployment.calls.at(-1)?.body).not.toHaveProperty("source");
		expect(json(result).note).toBe("envelope at the desk");

		const listed = json(await tool("list_donations"));
		expect(listed.data).toContainEqual(
			expect.objectContaining({ note: "envelope at the desk" }),
		);
	});

	test("list_forms with no filters returns the donation page form the deployment listed", async () => {
		const forms = json(await tool("list_forms"));
		expect(forms.data).toContainEqual(
			expect.objectContaining({ id: "frm_1", name: "Default form" }),
		);

		const page = json(await tool("get_donation_page"));
		expect(page.blocks).toContainEqual({
			type: "donate_form",
			form_id: "frm_1",
		});
	});

	test("list_forms includes a campaign's form with its campaign_id", async () => {
		const campaign = json(
			await tool("create_campaign", { title: "Winter coats" }),
		);
		const forms = json(await tool("list_forms"));

		expect(forms.data).toContainEqual(
			expect.objectContaining({ id: "frm_1", campaign_id: null }),
		);
		expect(forms.data).toContainEqual(
			expect.objectContaining({
				name: "Winter coats form",
				campaign_id: campaign.id,
			}),
		);
	});

	test("list_forms says the list includes page and campaign forms", async () => {
		const tools: { name: string; description: string }[] = await listTools();
		const description =
			tools.find((t) => t.name === "list_forms")?.description ?? "";

		expect(description).toContain(
			"donation page's form and each campaign's form",
		);
		expect(description).toContain("campaign_id");
		expect(description).not.toContain("leaves out");
	});

	test("record_donation trims the note and refuses one over the deployment's limit", async () => {
		await tool("record_donation", { ...GIFT, note: "  envelope  " });
		expect(deployment.calls.at(-1)?.body).toEqual({
			...GIFT,
			note: "envelope",
		});

		const before = deployment.calls.length;
		const long = await tool("record_donation", {
			...GIFT,
			note: "x".repeat(MAX_NOTE + 1),
		});
		expect(long.isError).toBe(true);
		expect(deployment.calls.length).toBe(before);
	});
});
