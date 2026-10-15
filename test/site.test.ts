import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app";
import type { Db } from "../src/db";
import { fakeDeployment } from "./fake-deployment";
import { BASE, env, warmUp } from "./harness";
import type { Call } from "./oauth";
import { freshDb } from "./support";

let db: Db;
let call: Call;

beforeEach(async () => {
	db = await freshDb();
	const served = createApp({ env, db, fetch: fakeDeployment().fetch });
	call = async (req) => served.request(req);
	// Auth seeds its tables on the first request. Wait for that before the
	// database closes, the way the other app tests do.
	await warmUp(call);
	return () => db.close();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const get = (path: string) => call(new Request(`${BASE}${path}`));

const PLACEHOLDERS = [
	"[EFFECTIVE DATE]",
	"[LEGAL ENTITY NAME]",
	"[POSTAL ADDRESS]",
	"[SUPPORT EMAIL]",
	"[30]",
	"[SECURITY EMAIL]",
	"[VERCEL LOG RETENTION PERIOD]",
	"[APPLICATION LOG RETENTION PERIOD]",
	"[HOSTING LOG RETENTION OF REQUEST BODIES]",
	"[KEY LIFETIME ON THE SITE WHEN REVOKE DOES NOT ARRIVE]",
	"[DISCONNECT FROM THE BETTER GIVING DASHBOARD]",
	"[LAWFUL BASIS — confirm with counsel if EU/UK users are in scope: account and relay processing on performance of a contract (GDPR Art. 6(1)(b)); security logging on legitimate interests (Art. 6(1)(f)).]",
	"[TRANSFER MECHANISM, e.g. Standard Contractual Clauses — confirm with counsel if EU/UK users are in scope.]",
	"[by email or in the dashboard]",
	"[or the age of majority where you live]",
	"[and open source]",
	"[DATA PROCESSING TERMS — attach or link a DPA if EU/UK operators are in scope.]",
	"[US$100]",
	"[GOVERNING LAW JURISDICTION]",
	"[VENUE]",
];

test.each(["/privacy", "/terms", "/docs", "/support"])(
	"%s is an html page",
	async (path) => {
		const res = await get(path);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/html/);
		const html = await res.text();
		expect(html).toContain("<!doctype html>");
		expect(html).toContain('href="/docs"');
		expect(html).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
		expect(html).not.toContain("://connect.better.giving");
	},
);

test("privacy and terms keep every undecided legal placeholder", async () => {
	const privacy = await (await get("/privacy")).text();
	const terms = await (await get("/terms")).text();
	const both = privacy + terms;

	for (const placeholder of PLACEHOLDERS) {
		expect(both).toContain(placeholder);
	}
	expect(privacy).toContain("90 days");
	expect(privacy).toContain("1 year");
	expect(privacy).toContain("AES-256-GCM");
	expect(privacy).not.toMatch(/not stored/i);
	expect(privacy).not.toMatch(/does not keep it/i);
	expect(privacy).not.toMatch(/not retained/i);
});

test("docs and support describe the connector without a support address", async () => {
	const docs = await (await get("/docs")).text();
	const support = await (await get("/support")).text();

	expect(docs).toContain("https://app.connect.better.giving/mcp");
	expect(docs).toContain("moves no money");
	expect(docs).toContain("Placeholder icon");
	expect(support).toContain("[SUPPORT EMAIL]");
	expect(support).toContain("has not been published yet");
	expect(support).toMatch(/does not move money/);
});

test("the placeholder icon is an svg and a 512px png", async () => {
	const svg = await get("/icon.svg");
	const png = await get("/icon-512.png");

	expect(svg.status).toBe(200);
	expect(svg.headers.get("content-type")).toMatch(/image\/svg\+xml/);
	const svgText = await svg.text();
	expect(svgText).toContain('viewBox="0 0 512 512"');
	expect(svgText).not.toContain("<script");

	expect(png.status).toBe(200);
	expect(png.headers.get("content-type")).toBe("image/png");
	const bytes = Buffer.from(await png.arrayBuffer());
	expect(bytes.subarray(0, 8)).toEqual(
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	);
	expect(bytes.readUInt32BE(16)).toBe(512);
	expect(bytes.readUInt32BE(20)).toBe(512);
});

test("the OpenAI challenge is 404 when the env var is unset", async () => {
	const res = await get("/.well-known/openai-apps-challenge");

	expect(res.status).toBe(404);
	expect(await res.text()).toBe("");
	expect(res.headers.get("cache-control")).toBe("no-store");
});

test("the OpenAI challenge returns the token as plain text and does not log it", async () => {
	const token = "openai-challenge-sentinel-9c4e";
	const lines = vi.spyOn(console, "log").mockImplementation(() => {});
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const served = createApp({
		env: { ...env, OPENAI_APPS_CHALLENGE: token },
		db,
		fetch: fakeDeployment().fetch,
	});
	await warmUp(async (req) => served.request(req));

	const res = await served.request(
		new Request(`${BASE}/.well-known/openai-apps-challenge`),
	);

	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
	expect(await res.text()).toBe(token);
	expect(res.headers.get("cache-control")).toBe("no-store");
	const logged = [...lines.mock.calls, ...errors.mock.calls].flat().join("\n");
	expect(logged).not.toContain(token);
});
