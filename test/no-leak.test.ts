import { inspect } from "node:util";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { createApp } from "../src/app";
import { createDb, type Db } from "../src/db";
import { migrate } from "../src/db/migrate";
import { ACTIONS } from "../src/mcp/actions";
import {
	ALL_ACTIONS,
	type FakeDeployment,
	fakeDeployment,
	hang,
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
import { connectFlow, shown } from "./operator";

// The whole service, driven the way operators and chat apps drive it, with a
// sentinel in everything that must stay out of a log line, an error or a
// header: the deployment's key, tool arguments, the deployment's answers, the
// Allow code, the tokens and the service's own secrets. Everything written to
// console.* and process.stdout/stderr, and every response the service gave, is
// scanned for them. Each scenario scans its own slice; the last test scans the
// whole run and fails if a scenario didn't run.

// --- sentinels ---------------------------------------------------------

type Sentinel = { label: string; value: string; inBodies: boolean };
const sentinels: Sentinel[] = [];

/** `inBodies`: the service may hand the value back in a response body. */
function plant(label: string, value: string, inBodies: boolean): string {
	if (!sentinels.some((s) => s.value === value)) {
		sentinels.push({ label, value, inBodies });
	}
	return value;
}

const arg = (name: string) =>
	plant(`arg:${name}`, `leak-arg-${name}-4f2a`, true);
const RESULT = plant("result", "leak-result-9b1c", true);
// A problem's `detail` is worded for the chat on purpose; its other fields stay behind.
const PROBLEM_DETAIL = plant(
	"problem-detail",
	"leak-problem-detail-5d7e",
	true,
);
const HIDDEN = plant("hidden-answer", "leak-hidden-answer-c3a8", false);
const ROTATED_SECRET = "another-connection-key-secret-bbbbbbbb";
plant("env:BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET, false);
plant("env:CONNECTION_KEY_SECRET", env.CONNECTION_KEY_SECRET, false);
plant("env:CRON_SECRET", env.CRON_SECRET, false);
plant("env:rotated-secret", ROTATED_SECRET, false);

const b64url = (text: string) => Buffer.from(text).toString("base64url");
const JWT_SUBJECT = "leak-jwt-subject-8e20";
const JWT = plant(
	"bearer:jwt",
	[
		b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
		b64url(
			JSON.stringify({
				sub: JWT_SUBJECT,
				iss: `${BASE}/api/auth`,
				aud: `${BASE}/mcp`,
				exp: 4102444800,
			}),
		),
		b64url("leak-jwt-signature-8e20"),
	].join("."),
	false,
);
plant("bearer:jwt-subject", JWT_SUBJECT, false);
const GARBAGE = plant("bearer:garbage", "leak-garbage-bearer-77d0", false);

// --- what was written and what was answered --------------------------------

type Sink = "output" | "header" | "body";
type Entry = { sink: Sink; scenario: string; text: string };
const trace: Entry[] = [];

const record = (sink: Sink, text: string) =>
	trace.push({
		sink,
		scenario: expect.getState().currentTestName ?? "",
		text,
	});

const textOfChunk = (chunk: unknown) =>
	chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : String(chunk);

const CONSOLE_METHODS = [
	"log",
	"info",
	"warn",
	"error",
	"debug",
	"trace",
	"dir",
	"table",
] as const;
let stopCapture: () => void = () => {};

function startCapture() {
	const spies = [
		...CONSOLE_METHODS.map((method) =>
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				record(
					"output",
					args
						.map((a) =>
							typeof a === "string" ? a : inspect(a, { depth: null }),
						)
						.join(" "),
				);
			}),
		),
		...([process.stdout, process.stderr] as const).map((stream) =>
			vi.spyOn(stream, "write").mockImplementation(((
				chunk: unknown,
				encoding?: unknown,
				done?: unknown,
			) => {
				record("output", textOfChunk(chunk));
				const callback = typeof encoding === "function" ? encoding : done;
				if (typeof callback === "function") callback();
				return true;
			}) as typeof stream.write),
		),
	];
	stopCapture = () => {
		for (const spy of spies) spy.mockRestore();
	};
}

type Leak = { sentinel: string; sink: Sink; scenario: string; near: string };

function leaksIn(entries: Entry[]): Leak[] {
	return entries.flatMap(({ sink, scenario, text }) =>
		sentinels
			.filter((s) => text.includes(s.value) && !(sink === "body" && s.inBodies))
			.map((s) => {
				const at = text.indexOf(s.value);
				return {
					sentinel: s.label,
					sink,
					scenario,
					near: text.slice(Math.max(0, at - 40), at + 60),
				};
			}),
	);
}

let mark = 0;
const expectNoLeaks = (from = mark) =>
	expect(leaksIn(trace.slice(from))).toEqual([]);

const loggedLines = () =>
	trace
		.filter((e) => e.sink === "output" && e.text.startsWith('{"kind":'))
		.map((e) => JSON.parse(e.text) as Record<string, unknown>);

// --- the service under test ----------------------------------------------

const ORG = "Hope Shelter";
const later = (minutes: number) => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + minutes * 60_000);
};

// The deployment's answers with sentinels in them: JSON successes gain a
// field, problems a hidden field and a detail.
function sentinelled(dep: FakeDeployment): typeof fetch {
	return async (input, init) => {
		const res = await dep.fetch(input, init);
		if (!(res.headers.get("content-type") ?? "").includes("json")) return res;
		const body: unknown = await res
			.clone()
			.json()
			.catch(() => undefined);
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return res;
		}
		const answered =
			res.status < 300
				? { ...body, leak_probe: RESULT }
				: { ...body, detail: PROBLEM_DETAIL, trace: HIDDEN };
		const headers = new Headers(res.headers);
		headers.delete("content-length");
		return new Response(JSON.stringify(answered), {
			status: res.status,
			headers,
		});
	};
}

class StoreDown extends Error {
	override name = "StoreDown";
}

type World = Awaited<ReturnType<typeof startWorld>>;
let world: World;
let version: McpVersion;
const deployments: FakeDeployment[] = [];

async function startWorld() {
	const db = createDb({ url: ":memory:" });
	await migrate(db);
	const dep = fakeDeployment({ name: ORG });
	deployments.push(dep);
	const net = sentinelled(dep);

	let failing: { match: RegExp; error: Error } | null = null;
	const flaky: Db = new Proxy(db, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop !== "execute") return value.bind(target);
			return (stmt: string | { sql: string }, ...rest: unknown[]) => {
				const sql = typeof stmt === "string" ? stmt : stmt.sql;
				if (failing?.match.test(sql)) return Promise.reject(failing.error);
				return value.call(target, stmt, ...rest);
			};
		},
	});

	// Records every response header and body this service answers with.
	const serve =
		(app: { request: (req: Request) => Response | Promise<Response> }): Call =>
		async (req) => {
			const res = await app.request(req);
			for (const [name, value] of res.headers)
				record("header", `${name}: ${value}`);
			for (const cookie of res.headers.getSetCookie())
				record("header", `set-cookie: ${cookie}`);
			record("body", await res.clone().text());
			return res;
		};

	const app = createApp({ env, db: flaky, fetch: net });
	const call = serve(app);
	await warmUp(call);
	const flow = connectFlow(call, dep, BASE);

	let rpcId = 0;
	const sendAs = (
		bearer: string | undefined,
		method: string,
		params?: Record<string, unknown>,
	) => call(mcpRequest(version, bearer, method, params, ++rpcId));

	return {
		db,
		dep,
		call,
		flow,
		sendAs,
		/** What a chat app opens with, answered with the instructions. */
		open: (bearer: string) => call(mcpOpen(version, bearer)),
		/** This service again over the same database, under another connection-key secret. */
		rotated: () =>
			serve(
				createApp({
					env: { ...env, CONNECTION_KEY_SECRET: ROTATED_SECRET },
					db,
					fetch: net,
				}),
			),
		failOn: (match: RegExp, error: Error) => {
			failing = { match, error };
		},
		/** Connects and returns the chat app's bearer, its tokens planted. */
		async signIn(): Promise<string> {
			const tokens = await flow.connect();
			plant("token:access", tokens.access_token, true);
			plant("token:refresh", tokens.refresh_token, true);
			return `Bearer ${tokens.access_token}`;
		},
	};
}

type ToolResult = { isError?: boolean; content: { text: string }[] };
const callTool = async (
	bearer: string,
	name: string,
	args: Record<string, unknown>,
): Promise<ToolResult> =>
	(
		await rpc(
			await world.sendAs(bearer, "tools/call", { name, arguments: args }),
		)
	).result;
const textOf = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
// A success carries the deployment's JSON as its text.
const answerOf = (r: ToolResult): Record<string, unknown> =>
	JSON.parse(textOf(r));

// Plants the keys the deployments minted, then scans this scenario's slice.
function expectCleanScenario() {
	for (const dep of deployments) {
		for (const key of dep.issuedKeys) {
			plant("key", key, false);
			plant("key:id", key.replace(/^bgk_/, ""), false);
		}
	}
	expectNoLeaks();
}

beforeAll(startCapture);
afterAll(() => stopCapture());

beforeEach(async () => {
	mark = trace.length;
	world = await startWorld();
	return () => world.db.close();
});

afterEach(() => {
	vi.useRealTimers();
});

// --- the instruments work --------------------------------------------------

// The probe is the one place besides src/log.ts that writes to the console.
function writeToConsole(
	method: (typeof CONSOLE_METHODS)[number],
	line: unknown,
) {
	// biome-ignore lint/suspicious/noConsole: feeds the capture a known line
	console[method](line);
}

test("the capture sees console and stdout/stderr writes, and the scan finds a planted sentinel", () => {
	const canary = plant("canary", "leak-canary-0000", false);
	const before = trace.length;

	for (const method of CONSOLE_METHODS) {
		writeToConsole(method, `${method} ${canary}`);
		writeToConsole(method, { nested: { method, canary } });
	}
	process.stdout.write(`stdout ${canary}\n`);
	process.stderr.write(Buffer.from(`stderr ${canary}\n`));

	const written = trace.slice(before);
	expect(written.map((e) => e.sink)).toEqual(Array(18).fill("output"));
	expect(written.every((e) => e.text.includes(canary))).toBe(true);
	expect(leaksIn(written).map((l) => l.sentinel)).toEqual(
		Array(18).fill("canary"),
	);
	// a body may carry what the service is allowed to hand back; a header may not
	expect(
		leaksIn([
			{ sink: "body", scenario: "", text: arg("probe") },
			{ sink: "header", scenario: "", text: arg("probe") },
			{ sink: "body", scenario: "", text: HIDDEN },
		]).map((l) => `${l.sink}:${l.sentinel}`),
	).toEqual(["header:arg:probe", "body:hidden-answer"]);
	trace.length = before;
});

describe.each(MCP_VERSIONS)("over MCP %s", (v) => {
	beforeAll(() => {
		version = v;
	});

	test("the sentinels reach the deployment and the chat, and the key reaches only the deployment", async () => {
		const bearer = await world.signIn();
		const note = arg("liveness-note");

		const result = await callTool(bearer, "record_donation", {
			amount: { amount: "12.00", currency: "USD" },
			date: "2026-01-02",
			donor: { name: arg("liveness-donor") },
			method: "cash",
			note,
		});

		const sent = world.dep.calls.at(-1);
		expect(sent?.body).toMatchObject({
			note,
			donor: { name: arg("liveness-donor") },
		});
		expect(sent?.authorization).toBe(`Bearer ${world.dep.issuedKeys[0]}`);
		expect(result.isError).toBeUndefined();
		expect(answerOf(result)).toMatchObject({ leak_probe: RESULT, note });
		expect(textOf(result)).not.toContain(
			world.dep.issuedKeys[0] ?? "unreachable",
		);
		expectCleanScenario();
	});

	// --- the connect walk ------------------------------------------------------

	const heading = async (res: Response) =>
		/<h1>(.*?)<\/h1>/.exec(shown(await res.text()))?.[1];

	const postAddress = (login: URL, address: string) =>
		world.call(
			new Request(login, {
				method: "POST",
				headers: { origin: BASE, "sec-fetch-site": "same-origin" },
				body: new URLSearchParams({ address }),
			}),
		);

	test("connect walk: a full connection, then /mcp initialize and tools/list", async () => {
		const at = await world.flow.toReturn();
		plant("allow-code", at.back.searchParams.get("code") ?? "", false);

		const tokens = await world.flow.finish(at);
		plant("token:access", tokens.access_token, true);
		plant("token:refresh", tokens.refresh_token, true);
		const bearer = `Bearer ${tokens.access_token}`;
		const init = await rpc(await world.open(bearer));
		const tools = await rpc(await world.sendAs(bearer, "tools/list"));

		expect(init.result.instructions).toContain(ORG);
		expect(tools.result.tools).toHaveLength(ACTIONS.length);
		expect(world.dep.issuedKeys).toHaveLength(1);
		expectCleanScenario();
	});

	test("connect walk: a denial", async () => {
		const { allow, cookie } = await world.flow.toReturn();
		const back = await world.flow.press(allow, "deny");

		const res = await world.flow.returnTo(back, cookie);

		expect(await heading(res)).toBe("Connection not allowed");
		expectCleanScenario();
	});

	test("connect walk: a return and an address that arrive after the request timed out", async () => {
		const at = await world.flow.toReturn();
		plant("allow-code", at.back.searchParams.get("code") ?? "", false);
		const login = (await world.flow.startSignIn()).login;
		later(11);

		const lateReturn = await world.flow.returnTo(at.back, at.cookie);
		const lateAddress = await postAddress(login, arg("late-address"));

		expect(await heading(lateReturn)).toBe("Connection request timed out");
		expect(await heading(lateAddress)).toBe("Connection request timed out");
		expectCleanScenario();
	});

	test("connect walk: a replayed return", async () => {
		const { back, cookie } = await world.flow.toReturn();
		plant("allow-code", back.searchParams.get("code") ?? "", false);
		expect((await world.flow.returnTo(back, cookie)).status).toBe(302);

		const replay = await world.flow.returnTo(back, cookie);

		expect(await heading(replay)).toBe("Couldn't finish connecting");
		expectCleanScenario();
	});

	test("connect walk: Cancel, and addresses the form refuses", async () => {
		const chat = await world.flow.startSignIn();
		const page = await world.call(new Request(chat.login));
		const cancelled = await world.flow.pressButton(page, "Cancel");
		const notAnAddress = await postAddress(
			chat.login,
			`${arg("not-an-address")} charity`,
		);
		const silent = await postAddress(
			chat.login,
			`${arg("silent-host")}.example`,
		);
		world.dep.intercept(
			() => new Response(`<h1>${HIDDEN}</h1>`, { status: 404 }),
		);
		const notBetterGiving = await postAddress(chat.login, world.dep.host);

		expect(cancelled.status).toBe(302);
		expect([
			notAnAddress.status,
			silent.status,
			notBetterGiving.status,
		]).toEqual([400, 502, 400]);
		expectCleanScenario();
	});

	test.each<[string, (dep: FakeDeployment) => void]>([
		[
			"a 503 page",
			(dep) => dep.intercept(() => new Response(HIDDEN, { status: 503 })),
		],
		[
			"a refusal with a problem",
			(dep) =>
				dep.intercept(() =>
					Response.json({ code: "forbidden", detail: HIDDEN }, { status: 403 }),
				),
		],
		[
			"a key-less success",
			(dep) => dep.intercept(() => Response.json({ name: HIDDEN })),
		],
		[
			"a spent code",
			(dep) =>
				dep.intercept((req) =>
					req.url.endsWith("/exchange")
						? Response.json({ code: "code_invalid" }, { status: 400 })
						: undefined,
				),
		],
	])("connect walk: an exchange answered with %s", async (_, arrange) => {
		const { back, cookie } = await world.flow.toReturn();
		arrange(world.dep);

		const res = await world.flow.returnTo(back, cookie);

		expect(await heading(res)).toBe("Couldn't finish connecting");
		expectCleanScenario();
	});

	test("connect walk: unexpected throws on the address and the return", async () => {
		world.dep.intercept(
			() =>
				new Response(null, { status: 301, headers: { location: "https://[" } }),
		);
		const address = await world.flow.submitAddress(world.dep.host);
		world.dep.intercept(null);
		const { back, cookie } = await world.flow.toReturn();
		world.failOn(
			/INSERT INTO "?connection/i,
			new StoreDown(`insert ${HIDDEN}`),
		);

		const stored = await world.flow.returnTo(back, cookie);

		expect(address.status).toBe(500);
		expect(stored.status).toBe(500);
		expectCleanScenario();
	});

	// --- every tool succeeding -----------------------------------------------------

	type Ids = { campaign: string; form: string; donor: string };
	const money = () => ({
		amount: plant("arg:amount", "7391.42", true),
		currency: "USD",
	});
	const day = (n: number) => plant(`arg:date-${n}`, `2031-04-${n}`, true);

	// In call order: later tools take the ids earlier ones made.
	const TOOLS: [string, (ids: Ids) => Record<string, unknown>][] = [
		["create_campaign", () => ({ title: arg("campaign-title") })],
		[
			"list_campaigns",
			() => ({ status: "draft", cursor: arg("cursor"), limit: 7 }),
		],
		["get_campaign", (i) => ({ id: i.campaign })],
		[
			"update_campaign_blocks",
			(i) => ({
				id: i.campaign,
				blocks: [{ type: "text", body: arg("block-body") }],
			}),
		],
		[
			"update_campaign_settings",
			(i) => ({
				id: i.campaign,
				goal: money(),
				end_date: day(17),
				sharing: {
					title: arg("share-title"),
					description: arg("share-description"),
				},
			}),
		],
		["publish_campaign", (i) => ({ id: i.campaign })],
		["unpublish_campaign", (i) => ({ id: i.campaign })],
		["end_campaign", (i) => ({ id: i.campaign })],
		["get_donation_page", () => ({})],
		[
			"update_donation_page_blocks",
			() => ({ blocks: [{ type: "hero", heading: arg("hero-heading") }] }),
		],
		["reset_donation_page", () => ({})],
		["get_block_catalog", () => ({})],
		["list_forms", () => ({ cursor: arg("forms-cursor"), limit: 3 })],
		["get_form", (i) => ({ id: i.form })],
		[
			"create_form",
			() => ({ name: arg("form-name"), blurb: arg("form-blurb") }),
		],
		["update_form", (i) => ({ id: i.form, name: arg("form-rename") })],
		[
			"record_donation",
			(i) => ({
				amount: money(),
				date: day(17),
				donor: {
					name: arg("donor-name"),
					email: "leak-arg-donor-email-4f2a@example.org",
				},
				campaign_id: i.campaign,
				method: "check",
				note: arg("note"),
			}),
		],
		["get_donor", (i) => ({ id: i.donor })],
		[
			"list_donors",
			() => ({ q: arg("donor-query"), cursor: arg("donors-cursor") }),
		],
		[
			"get_results",
			(i) => ({ campaign_id: i.campaign, from: day(16), to: day(18) }),
		],
		[
			"list_donations",
			(i) => ({
				campaign_id: i.campaign,
				from: day(16),
				to: day(18),
				cursor: arg("gifts-cursor"),
			}),
		],
		["list_recurring_gifts", () => ({ cursor: arg("recurring-cursor") })],
		[
			"create_photo_upload_link",
			(i) => ({
				target: { kind: "campaign", id: i.campaign },
				slot: arg("slot"),
			}),
		],
	];
	plant("arg:donor-email", "leak-arg-donor-email-4f2a@example.org", true);

	// The tools that name a record: with an id nobody has, the deployment says 404.
	const NAME_A_RECORD = [
		"get_campaign",
		"update_campaign_blocks",
		"update_campaign_settings",
		"publish_campaign",
		"unpublish_campaign",
		"end_campaign",
		"get_form",
		"update_form",
		"get_donor",
		"create_photo_upload_link",
		"record_donation",
	];

	test("the table covers every tool the service offers", async () => {
		const bearer = await world.signIn();

		const listed = (await rpc(await world.sendAs(bearer, "tools/list"))).result
			.tools;

		const names = (tools: { name: string }[]) =>
			tools.map((t) => t.name).toSorted();
		expect(names(TOOLS.map(([name]) => ({ name })))).toEqual(names(listed));
		expect(names(ACTIONS.map((a) => ({ name: a.tool })))).toEqual(
			names(listed),
		);
	});

	test("every tool succeeds with sentinel arguments against sentinel answers", async () => {
		const bearer = await world.signIn();
		const ids: Ids = { campaign: "", form: "frm_1", donor: "" };

		for (const [name, build] of TOOLS) {
			const planted = sentinels.length;
			const args = build(ids);
			const mine = sentinels.slice(planted).map((s) => s.value);

			const result = await callTool(bearer, name, args);

			expect({ name, isError: result.isError }).toEqual({
				name,
				isError: undefined,
			});
			const answer = answerOf(result);
			expect({ name, probe: answer.leak_probe }).toEqual({
				name,
				probe: RESULT,
			});
			const reached = JSON.stringify(world.dep.calls.at(-1));
			for (const value of mine)
				expect({ name, reached: reached.includes(value) }).toEqual({
					name,
					reached: true,
				});
			if (name === "create_campaign") ids.campaign = String(answer.id);
			if (name === "record_donation") ids.donor = String(answer.donor_id);
		}
		expect(ids.campaign).not.toBe("");
		expect(ids.donor).not.toBe("");
		expectCleanScenario();
	});

	test("a sentinel id no deployment knows is a rejection that echoes only the problem's detail", async () => {
		const bearer = await world.signIn();
		const unknown = arg("unknown-id");
		const ids: Ids = { campaign: unknown, form: unknown, donor: unknown };

		for (const [name, build] of TOOLS) {
			if (!NAME_A_RECORD.includes(name)) continue;
			const result = await callTool(bearer, name, build(ids));

			expect({ name, isError: result.isError }).toEqual({
				name,
				isError: true,
			});
			expect(JSON.parse(textOf(result))).toMatchObject({
				detail: PROBLEM_DETAIL,
				code: "not_found",
			});
			expect(JSON.stringify(world.dep.calls.at(-1))).toContain(unknown);
		}
		expectCleanScenario();
	});

	// --- each failure kind --------------------------------------------------------

	const GIFT = () => ({
		amount: money(),
		date: day(17),
		donor: {
			name: arg("fail-donor"),
			email: "leak-arg-donor-email-4f2a@example.org",
		},
		method: "bank_transfer",
		note: arg("fail-note"),
	});

	// A read (the arguments ride in the query) and a write (in the body, and its
	// lost answer is worded differently): the two shapes a failure can meet.
	type ToolCall = readonly [string, Record<string, unknown>];
	const READ_CALL = (): ToolCall => [
		"list_donors",
		{ q: arg("fail-query"), cursor: arg("fail-cursor") },
	];
	const WRITE_CALL = (): ToolCall => ["record_donation", GIFT()] as const;

	test.each<[string, string, (w: World) => void]>([
		[
			"a missing action",
			"Update Better Giving",
			(w) =>
				w.dep.setActions(
					ALL_ACTIONS.filter(
						(a) => a !== "donors.list" && a !== "donations.record",
					),
				),
		],
		[
			"a 4xx problem",
			PROBLEM_DETAIL,
			(w) =>
				w.dep.intercept(() =>
					Response.json(
						{
							type: "about:blank",
							title: "validation_failed",
							status: 422,
							code: "validation_failed",
							errors: [{ path: "donor.name", message: "too short" }],
						},
						{
							status: 422,
							headers: { "content-type": "application/problem+json" },
						},
					),
				),
		],
		[
			"a 5xx problem",
			"didn't answer",
			(w) =>
				w.dep.intercept(() =>
					Response.json({ code: "boom", detail: HIDDEN }, { status: 500 }),
				),
		],
		[
			"a 5xx page",
			"didn't answer",
			(w) =>
				w.dep.intercept(
					() => new Response(`upstream ${HIDDEN}`, { status: 502 }),
				),
		],
		[
			"a 200 that isn't JSON",
			"didn't answer",
			(w) =>
				w.dep.intercept(
					() => new Response(`<html>${HIDDEN}</html>`, { status: 200 }),
				),
		],
		[
			"a 403 page",
			"refused this request",
			(w) =>
				w.dep.intercept(
					() => new Response(`<h1>${HIDDEN}</h1>`, { status: 403 }),
				),
		],
		[
			"a site that is down",
			"didn't answer",
			(w) =>
				w.dep.intercept(() => {
					throw new TypeError(`fetch failed ${HIDDEN}`);
				}),
		],
	])("a read and a write meeting %s", async (_, said, arrange) => {
		const bearer = await world.signIn();
		arrange(world);

		const read = await callTool(bearer, ...READ_CALL());
		const write = await callTool(bearer, ...WRITE_CALL());

		expect([read.isError, write.isError]).toEqual([true, true]);
		expect(textOf(read)).toContain(said);
		expectCleanScenario();
	});

	test("a write meeting a refused key says reconnect and drops the connection", async () => {
		const bearer = await world.signIn();
		world.dep.refuseKeys();

		const result = await callTool(bearer, ...WRITE_CALL());

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Reconnect Better Giving");
		expect((await world.sendAs(bearer, "tools/list")).status).toBe(401);
		expectCleanScenario();
	});

	test("a read meeting a refused key says reconnect and drops the connection", async () => {
		const bearer = await world.signIn();
		world.dep.refuseKeys();

		const result = await callTool(bearer, ...READ_CALL());

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Reconnect Better Giving");
		expectCleanScenario();
	});

	test("a read meeting a site that moved says reconnect at the new address, sends the key nowhere else and drops the connection", async () => {
		const bearer = await world.signIn();
		world.dep.intercept(
			() =>
				new Response(null, {
					status: 308,
					headers: { location: `https://moved.example.org/${HIDDEN}` },
				}),
		);

		const result = await callTool(bearer, ...READ_CALL());

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("has moved to a new address");
		expect(new Set(world.dep.calls.map((c) => c.host))).toEqual(
			new Set([world.dep.host]),
		);
		expect((await world.sendAs(bearer, "tools/list")).status).toBe(401);
		expectCleanScenario();
	});

	test("a write its schema refuses never reaches the deployment", async () => {
		const bearer = await world.signIn();
		const before = world.dep.calls.length;

		const result = await callTool(bearer, "record_donation", {
			...GIFT(),
			date: arg("not-a-date"),
		});

		expect(result.isError).toBe(true);
		expect(world.dep.calls.length).toBe(before);
		expectCleanScenario();
	});

	test("a read and a write to a site that never answers time out", async () => {
		const bearer = await world.signIn();
		let reached = 0;
		world.dep.intercept((req) => {
			reached++;
			return hang(req);
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const results: ToolResult[] = [];
		for (const call of [READ_CALL(), WRITE_CALL()]) {
			const pending = callTool(bearer, ...call);
			await vi.waitFor(() => expect(reached).toBe(results.length + 1));
			await vi.advanceTimersByTimeAsync(15_000);
			results.push(await pending);
		}

		expect(results.map((r) => r.isError)).toEqual([true, true]);
		expect(textOf(results[0] as ToolResult)).toContain("didn't answer");
		expectCleanScenario();
	});

	test("an unexpected throw while dropping a refused connection, and one while reading the connection", async () => {
		const bearer = await world.signIn();
		world.dep.refuseKeys();
		world.failOn(/DELETE FROM connection/i, new StoreDown(`drop ${HIDDEN}`));
		const dropping = await callTool(bearer, ...READ_CALL());
		world.failOn(/FROM connection/i, new StoreDown(`read ${HIDDEN}`));

		const reading = await world.sendAs(bearer, "tools/call", {
			name: "record_donation",
			arguments: GIFT(),
		});

		expect(dropping.isError).toBe(true);
		expect(reading.status).toBe(500);
		expectCleanScenario();
	});

	// --- the door: the connection and the bearer ---------------------------------------

	test("a deploy under another connection-key secret fails without a trace of the key, and the right one serves again", async () => {
		const bearer = await world.signIn();
		const rotated = world.rotated();

		const res = await rotated(mcpOpen(version, bearer));
		const again = await rotated(
			mcpRequest(version, bearer, "tools/call", {
				name: "record_donation",
				arguments: GIFT(),
			}),
		);
		const restored = await callTool(bearer, ...READ_CALL());

		expect([res.status, again.status]).toEqual([500, 500]);
		expect(restored.isError).toBeUndefined();
		expectCleanScenario();
	});

	test("a stored key that can't be decrypted ends the connection without a trace of the key", async () => {
		const bearer = await world.signIn();
		await world.db.execute("UPDATE connection SET key_ct = key_ct || 'AA'");

		const res = await world.sendAs(bearer, "tools/call", {
			name: "record_donation",
			arguments: GIFT(),
		});
		const again = await world.sendAs(bearer, "tools/list");

		expect([res.status, again.status]).toEqual([401, 401]);
		expectCleanScenario();
	});

	test("a JWT-shaped bearer, a garbage bearer and a damaged real token are all refused quietly", async () => {
		const real = await world.signIn();
		const damaged = plant(
			"bearer:damaged",
			`${real.slice(0, -1)}${real.endsWith("a") ? "b" : "a"}`,
			false,
		);

		const statuses: number[] = [];
		for (const bearer of [`Bearer ${JWT}`, `Bearer ${GARBAGE}`, damaged]) {
			statuses.push((await world.open(bearer)).status);
			const call = await world.sendAs(bearer, "tools/call", {
				name: "record_donation",
				arguments: GIFT(),
			});
			statuses.push(call.status);
		}

		expect(statuses).toEqual(Array(6).fill(401));
		expectCleanScenario();
	});

	test("the cron sweep refuses a wrong or missing bearer and answers the right one, none of it showing the secret", async () => {
		await world.signIn();
		const sweep = (authorization?: string) =>
			world.call(
				new Request(`${BASE}/cron/sweep`, {
					headers: authorization ? { authorization } : {},
				}),
			);

		const refused = [
			await sweep(),
			await sweep(
				`Bearer ${plant("bearer:wrong-cron", "leak-wrong-cron-1b9d", false)}`,
			),
			await sweep(`Bearer ${env.BETTER_AUTH_SECRET}`),
		];
		const accepted = await sweep(`Bearer ${env.CRON_SECRET}`);
		world.failOn(/SELECT/i, new StoreDown(`sweep ${HIDDEN}`));
		const broken = await sweep(`Bearer ${env.CRON_SECRET}`);

		expect(refused.map((r) => r.status)).toEqual([401, 401, 401]);
		expect(accepted.status).toBe(200);
		expect(await accepted.json()).toEqual({ connections: 0 });
		expect(broken.status).toBe(500);
		expectCleanScenario();
	});
});

// --- the whole run ---------------------------------------------------------------

test("across the whole run nothing written or answered carries a sentinel", () => {
	// Runs after the scenarios above and fails, rather than passes empty, when
	// they didn't run (a name filter, a bail).
	const lines = loggedLines();
	const tools = new Set(
		lines.filter((l) => l.kind === "tool").map((l) => l.tool),
	);
	const outcomes = (kind: string, field: string) =>
		new Set(lines.filter((l) => l.kind === kind).map((l) => l[field]));
	const errorSites = outcomes("error", "where");

	expect(tools).toEqual(new Set(ACTIONS.map((a) => a.action)));
	expect(outcomes("tool", "outcome")).toEqual(
		new Set([
			"ok",
			"invalid_input",
			"key_refused",
			"moved",
			"needs_update",
			"rejected",
			"unreachable",
			"failed",
		]),
	);
	for (const outcome of [
		"ok",
		"denied",
		"expired",
		"invalid_address",
		"unreachable",
		"needs_update",
		"failed",
	]) {
		expect(outcomes("connect", "outcome")).toContain(outcome);
	}
	expect(errorSites).toEqual(new Set(["mcp", "connect", "app"]));
	expect(new Set(trace.map((e) => e.sink))).toEqual(
		new Set(["output", "header", "body"]),
	);

	expectNoLeaks(0);
});
