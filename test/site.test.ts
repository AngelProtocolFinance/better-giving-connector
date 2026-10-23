import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app";
import {
	ACCESS_TOKEN_EXPIRES_IN,
	lifetimeLabel,
	RATE_LIMIT_RETENTION,
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

	const flat = privacy.replace(/\s+/g, " ");
	expect(flat).toContain(
		"Logs are kept for a limited period set by our hosting provider, then deleted. We don&#39;t send these logs to any other service.",
	);
	expect(privacy).not.toContain("up to 30 days");
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
	expect(flat).toContain(
		"Tool requests and results are held in memory only while a request runs. They are not written to our database or logs.",
	);
	expect(flat).toContain(
		"The Better Giving Standalone site you connect to revokes a connection key after 90 days without use, and deletes revoked keys 30 days later.",
	);
	expect(flat).toContain(
		"stored as one-way (SHA-256) hashes, not the tokens themselves.",
	);
	expect(flat).toContain(
		"To handle a retried refresh, the latest token response is also kept encrypted. It can be used only for 30 seconds, and the daily sweep deletes it within a day after that.",
	);
	expect(flat).toContain("The session token is stored as the token itself.");
	expect(flat).toContain(
		"A random ID and a placeholder email address at @connection.invalid. The stored account name is the constant &quot;Better Giving connection&quot;. No name or email address is collected.",
	);
	expect(flat).toContain(
		"OAuth client registrations store a client ID, a name, redirect URLs, optional contacts, a logo, policy URLs, and metadata supplied by the app developer, and an encrypted client secret. Contacts may include the developer&#39;s email. They are kept while the app remains registered; contact us to have one removed.",
	);
	expect(flat).not.toMatch(/no personal data/i);
	expect(flat).toContain(
		"A consent record of which app was authorized, and which scopes, is deleted with the connection.",
	);
	expect(flat).toContain(
		"Authorization codes are single-use, stored as one-way (SHA-256) hashes, not the codes themselves, and expire within minutes. The row holds the authorization request details, not the code, until the code is used or it expires.",
	);
	expect(flat).toContain(
		"A counter whose key is the client IP address and the endpoint. An IPv6 address is stored as its /64. When a client IP address is not available, that endpoint has one shared counter.",
	);
	expect(flat).toContain(
		`A counter is deleted when its last request is more than ${lifetimeLabel(RATE_LIMIT_RETENTION)} old.`,
	);
	expect(flat).toContain(
		"under a key held in our hosting provider&#39;s production environment, separate from the database.",
	);
	expect(privacy).toContain("We do not use analytics or telemetry.");
	expect(privacy).toContain(
		"Your Better Giving site receives the connection key with each request.",
	);
	expect(flat).toContain(
		'href="https://github.com/AngelProtocolFinance/better-giving-connector"',
	);
	expect(flat).toContain("open source");
	expect(flat).toContain("No system is perfectly secure.");
	expect(flat).not.toMatch(/\bnever\b|\bguarantee\b/i);
	expect(flat.match(/\bsecure\b/gi)).toEqual(["secure"]);
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
	const privacy = await (await get("/privacy")).text();
	const terms = await (await get("/terms")).text();

	expect(docs).toContain("https://app.connect.better.giving/mcp");
	expect(docs).toContain('href="/demo.mp4"');
	expect(docs).toContain('src="/demo.vtt"');
	expect(docs).toContain("moves no money");
	expect(docs).toContain("Better Giving logo");
	expect(docs).toContain('rel="icon" href="/icon.svg"');
	expect(docs).not.toMatch(/placeholder/i);
	expect(docs).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
	expect(support).toContain("support@better.giving");
	expect(support).toContain("security@better.giving");
	expect(support).not.toContain("has not been published yet");
	expect(support).toMatch(/does not move money/);

	const pages = docs + support + privacy + terms;
	expect(pages).not.toMatch(/self-hosted/i);
	expect(pages).not.toMatch(/Claude|ChatGPT|Anthropic|OpenAI/);
	expect(docs).toContain("better.giving");
	expect(docs).toContain("your own Better Giving site&#39;s address");
	expect(docs).toContain("in cash or by check");
	expect(docs).toContain("distinguishing note");
	expect(docs).toContain("explicit yes");
	expect(docs).toContain("general fund");
	expect(docs).not.toMatch(/bank transfer/i);
	expect(docs).toContain("For the amount raised, use fundraising results.");
	expect(docs).toContain("including the donation");
	expect(docs).not.toContain("leaves out a form");
	expect(support).toContain("in cash or by check");
	expect(privacy).toContain("your AI assistant");
	expect(terms).toContain("better.giving");
});

test("the logo is a square svg and a 512px png", async () => {
	const svg = await get("/icon.svg");
	const png = await get("/icon-512.png");

	expect(svg.status).toBe(200);
	expect(svg.headers.get("content-type")).toMatch(/image\/svg\+xml/);
	const svgText = await svg.text();
	expect(svgText).toContain('width="512"');
	expect(svgText).toContain('height="512"');
	expect(svgText).toContain('viewBox="0 0 512 512"');
	expect(svgText).toContain("<title>Better Giving</title>");
	expect(svgText).not.toContain("<script");
	expect(svgText).not.toContain("<image");
	expect(svgText).not.toMatch(/placeholder/i);

	expect(png.status).toBe(200);
	expect(png.headers.get("content-type")).toBe("image/png");
	const bytes = Buffer.from(await png.arrayBuffer());
	expect(bytes.subarray(0, 8)).toEqual(
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	);
	expect(bytes.readUInt32BE(16)).toBe(512);
	expect(bytes.readUInt32BE(20)).toBe(512);
});

test("the root path redirects to the docs", async () => {
	const res = await call(new Request(`${BASE}/`, { redirect: "manual" }));

	expect(res.status).toBe(302);
	expect(res.headers.get("location")).toBe("/docs");
});

test("the demo recording is an mp4", async () => {
	const res = await get("/demo.mp4");

	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("video/mp4");
	expect(res.headers.get("accept-ranges")).toBe("bytes");
	const bytes = Buffer.from(await res.arrayBuffer());
	expect(bytes.subarray(4, 8).toString()).toBe("ftyp");

	const partial = await call(
		new Request(`${BASE}/demo.mp4`, { headers: { range: "bytes=0-7" } }),
	);
	expect(partial.status).toBe(206);
	expect(partial.headers.get("content-range")).toBe(
		`bytes 0-7/${bytes.byteLength}`,
	);
	expect(Buffer.from(await partial.arrayBuffer()).byteLength).toBe(8);

	const size = bytes.byteLength;
	const overlong = await call(
		new Request(`${BASE}/demo.mp4`, {
			headers: { range: `bytes=0-${size}` },
		}),
	);
	expect(overlong.status).toBe(206);
	expect(overlong.headers.get("content-range")).toBe(
		`bytes 0-${size - 1}/${size}`,
	);
	expect(Buffer.from(await overlong.arrayBuffer()).byteLength).toBe(size);

	const tail = await call(
		new Request(`${BASE}/demo.mp4`, { headers: { range: "bytes=-8" } }),
	);
	expect(tail.status).toBe(206);
	expect(tail.headers.get("content-range")).toBe(
		`bytes ${size - 8}-${size - 1}/${size}`,
	);
	expect(Buffer.from(await tail.arrayBuffer())).toEqual(bytes.subarray(-8));

	const whole = await call(
		new Request(`${BASE}/demo.mp4`, {
			headers: { range: `bytes=-${size + 10}` },
		}),
	);
	expect(whole.status).toBe(206);
	expect(whole.headers.get("content-range")).toBe(
		`bytes 0-${size - 1}/${size}`,
	);

	const past = await call(
		new Request(`${BASE}/demo.mp4`, {
			headers: { range: `bytes=${size}-` },
		}),
	);
	expect(past.status).toBe(416);
	expect(past.headers.get("content-range")).toBe(`bytes */${size}`);

	const captions = await get("/demo.vtt");
	expect(captions.status).toBe(200);
	expect(captions.headers.get("content-type")).toMatch(/text\/vtt/);
	expect(await captions.text()).toMatch(/^WEBVTT/);
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
