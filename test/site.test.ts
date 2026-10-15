import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app";
import {
	ACCESS_TOKEN_EXPIRES_IN,
	lifetimeLabel,
	REFRESH_TOKEN_EXPIRES_IN,
	SESSION_EXPIRES_IN,
} from "../src/auth/token-lifetimes";
import type { Db } from "../src/db";
import { EFFECTIVE_DATE } from "../src/site/effective-date";
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

test.each(["/privacy", "/terms", "/docs", "/support"])(
	"%s is an html page",
	async (path) => {
		const res = await get(path);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/html/);
		const html = await res.text();
		expect(html).toContain("<!doctype html>");
		expect(html).toContain('href="/docs"');
		expect(html).not.toContain("://connect.better.giving");
	},
);

test("privacy and terms use the filled wording and the build date", async () => {
	const privacy = await (await get("/privacy")).text();
	const terms = await (await get("/terms")).text();
	const support = await (await get("/support")).text();
	const both = privacy + terms + support;

	expect(EFFECTIVE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	expect(privacy).toContain(`Effective date: ${EFFECTIVE_DATE}`);
	expect(privacy).toContain(`Last updated: ${EFFECTIVE_DATE}`);
	expect(terms).toContain(`Effective date: ${EFFECTIVE_DATE}`);
	expect(both).not.toContain("[EFFECTIVE DATE]");
	expect(both).not.toContain("[30]");
	expect(both).not.toContain("[APPLICATION LOG");
	expect(both).not.toContain("[TRANSFER MECHANISM");
	expect(both).not.toContain("[by email or in the dashboard]");
	expect(both).not.toContain("[and open source]");
	expect(both).not.toContain("[DATA PROCESSING TERMS");
	expect(both).not.toContain("Data Privacy Framework");
	expect(both).not.toContain('class="placeholder"');

	expect(REFRESH_TOKEN_EXPIRES_IN).toBe(60 * 60 * 24 * 90);
	expect(ACCESS_TOKEN_EXPIRES_IN).toBe(60 * 60);
	expect(SESSION_EXPIRES_IN).toBe(60 * 60 * 24 * 365);
	expect(privacy).toContain(
		`A refresh token expires after ${lifetimeLabel(REFRESH_TOKEN_EXPIRES_IN)} without use.`,
	);
	expect(privacy).toContain(
		`An access token expires after ${lifetimeLabel(ACCESS_TOKEN_EXPIRES_IN)}.`,
	);
	expect(privacy).toContain(
		`A session lasts up to ${lifetimeLabel(SESSION_EXPIRES_IN)}.`,
	);
	expect(lifetimeLabel(REFRESH_TOKEN_EXPIRES_IN)).toBe("90 days");
	expect(lifetimeLabel(ACCESS_TOKEN_EXPIRES_IN)).toBe("1 hour");
	expect(lifetimeLabel(SESSION_EXPIRES_IN)).toBe("1 year");

	expect(privacy).toContain(
		"<strong>Application logs:</strong> up to 30 days.",
	);
	expect(privacy).toContain("We respond within 30 days.");
	expect(support).toContain("Response time: 30 days.");
	expect(terms).toContain("no sooner than 30 days after notice");
	expect(privacy).toContain(
		"We process data in the United States. Where EU or UK law requires it, we rely on the European Commission&#39;s Standard Contractual Clauses and the UK Addendum.",
	);
	expect(privacy).toContain(
		"by email to the nonprofit&#39;s account administrator and by posting the updated page, at least 7 days before the change takes effect.",
	);
	expect(terms).toContain(
		'The <a href="https://github.com/AngelProtocolFinance/better-giving-connector">Better Giving connector</a> and Better Giving Standalone are open source.',
	);
	expect(terms).toContain(
		"Nonprofits that need a data processing agreement can request one at support@better.giving.",
	);

	expect(privacy).toContain("AES-256-GCM");
	expect(privacy).toContain("Better Giving, Inc.");
	expect(privacy).toContain("18 Cottekill Rd, Rosendale, NY 12472");
	expect(privacy).toContain("support@better.giving");
	expect(privacy).toContain("security@better.giving");
	expect(privacy).toContain("Tool data is not stored.");
	expect(privacy).toContain(
		"A connection key is revoked when the nonprofit disconnects, or automatically after 90 days without use. Connection codes are single-use.",
	);
	expect(privacy).toContain(
		"Our hosting provider keeps request logs, including the request path, the approximate region from your IP address, and your browser or client type, for up to 30 days.",
	);
	expect(privacy).toContain("California Consumer Privacy Act");
	expect(privacy).toContain("GDPR Article 6(1)(b)");
	expect(privacy).not.toMatch(/does not keep it/i);
	expect(privacy).not.toMatch(/not retained/i);
	expect(terms).toContain("at least 18");
	expect(terms).toContain("State of New York");
	expect(terms).toContain("New York courts");
	expect(terms).toContain("OR $100");
});

test("docs and support describe the connector and name the support address", async () => {
	const docs = await (await get("/docs")).text();
	const support = await (await get("/support")).text();

	expect(docs).toContain("https://app.connect.better.giving/mcp");
	expect(docs).toContain("moves no money");
	expect(docs).toContain("Placeholder icon");
	expect(docs).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
	expect(support).toContain("support@better.giving");
	expect(support).toContain("security@better.giving");
	expect(support).not.toContain("has not been published yet");
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
