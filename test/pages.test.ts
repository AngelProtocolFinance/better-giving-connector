import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/app";
import type { Db } from "../src/db";
import { ICON_PNG, ICON_SVG } from "../src/site/icon";
import { PLACEHOLDERS } from "../src/site/placeholders";
import { fakeDeployment } from "./fake-deployment";
import { BASE, env, warmUp } from "./harness";
import type { Call } from "./oauth";
import { freshDb } from "./support";

let db: Db;
let call: Call;

beforeEach(async () => {
	db = await freshDb();
	const deployment = fakeDeployment();
	const app = createApp({ env, db, fetch: deployment.fetch });
	call = async (req) => app.request(req);
	await warmUp(call);
	return () => db.close();
});

const html = async (path: string) => {
	const res = await call(new Request(`${BASE}${path}`));
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toMatch(/text\/html/);
	return res.text();
};

test.each(["/docs", "/support", "/privacy", "/terms"])(
	"%s is a page that links the other directory pages",
	async (path) => {
		const body = await html(path);

		for (const href of ["/docs", "/support", "/privacy", "/terms"]) {
			expect(body).toContain(`href="${href}"`);
		}
		expect(body).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
		expect(body).not.toContain("Justin");
		expect(body).not.toContain("Delaware");
		expect(body.replaceAll("app.connect.better.giving", "")).not.toContain(
			"connect.better.giving",
		);
	},
);

test("privacy states the retention the code implements and leaves the rest marked", async () => {
	const body = await html("/privacy");

	expect(body).toContain("90 days");
	expect(body).toContain("365 days");
	expect(body).toContain("AES-256-GCM");
	expect(body).toContain("one hour");
	expect(body).not.toContain("does not keep");
	expect(body).not.toContain("not stored");
	expect(body).not.toContain("not retained");
	for (const text of [
		PLACEHOLDERS.entity,
		PLACEHOLDERS.address,
		PLACEHOLDERS.supportEmail,
		PLACEHOLDERS.securityEmail,
		PLACEHOLDERS.effectiveDate,
		PLACEHOLDERS.lawfulBasis,
		PLACEHOLDERS.transfer,
		PLACEHOLDERS.vercelLogRetention,
		PLACEHOLDERS.applicationLogRetention,
		PLACEHOLDERS.passThroughRetention,
		PLACEHOLDERS.keyRevocationUnreachable,
		PLACEHOLDERS.responseDeadline,
		PLACEHOLDERS.noticeMethod,
		PLACEHOLDERS.dashboardDisconnect,
	]) {
		expect(body).toContain(text);
	}
});

test("terms leaves undecided legal terms marked", async () => {
	const body = await html("/terms");

	expect(body).toContain("does not process payments");
	for (const text of [
		PLACEHOLDERS.entity,
		PLACEHOLDERS.address,
		PLACEHOLDERS.supportEmail,
		PLACEHOLDERS.effectiveDate,
		PLACEHOLDERS.governingLaw,
		PLACEHOLDERS.venue,
		PLACEHOLDERS.minimumAge,
		PLACEHOLDERS.noticePeriod,
		PLACEHOLDERS.liabilityCap,
		PLACEHOLDERS.openSource,
		PLACEHOLDERS.dataProcessingTerms,
	]) {
		expect(body).toContain(text);
	}
	expect(body).not.toContain("US$100");
	expect(body).not.toContain("30 days");
});

test("docs names the server, the offline-donation limit, and the icon paths", async () => {
	const body = await html("/docs");

	expect(body).toContain("https://app.connect.better.giving/mcp");
	expect(body).toContain("moves no money");
	expect(body).toContain('href="/icon.svg"');
	expect(body).toContain('href="/icon-512.png"');
	expect(body).not.toContain(PLACEHOLDERS.supportEmail);
});

test("support names the contact placeholders and does not invent an address", async () => {
	const body = await html("/support");

	expect(body).toContain(PLACEHOLDERS.supportEmail);
	expect(body).toContain(PLACEHOLDERS.securityEmail);
	expect(body).toContain(PLACEHOLDERS.dashboardDisconnect);
	expect(body).toContain("cannot refund");
});

test("the placeholder icon is an SVG and a 512px PNG at stable paths", async () => {
	const svg = await call(new Request(`${BASE}/icon.svg`));
	const png = await call(new Request(`${BASE}/icon-512.png`));

	expect(svg.status).toBe(200);
	expect(svg.headers.get("content-type")).toMatch(/image\/svg\+xml/);
	expect(await svg.text()).toBe(ICON_SVG);
	expect(png.status).toBe(200);
	expect(png.headers.get("content-type")).toBe("image/png");
	const bytes = new Uint8Array(await png.arrayBuffer());
	expect(Buffer.from(bytes)).toEqual(Buffer.from(ICON_PNG));
	expect(Buffer.from(bytes.subarray(12, 16)).toString()).toBe("IHDR");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	expect(view.getUint32(16)).toBe(512);
	expect(view.getUint32(20)).toBe(512);
});

test("the OpenAI challenge route is 404 until the env var is set", async () => {
	const missing = await call(
		new Request(`${BASE}/.well-known/openai-apps-challenge`),
	);

	expect(missing.status).toBe(404);
	expect(await missing.text()).toBe("");
});

test("the OpenAI challenge route returns the env token as plain text", async () => {
	const token = "openai-apps-challenge-token-abc123";
	const wired = createApp({
		env: { ...env, OPENAI_APPS_CHALLENGE: token },
		db,
		fetch: fakeDeployment().fetch,
	});
	await warmUp(async (req) => wired.request(req));

	const res = await wired.request(
		new Request(`${BASE}/.well-known/openai-apps-challenge`),
	);

	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
	expect(res.headers.get("cache-control")).toBe("no-store");
	expect(await res.text()).toBe(token);
});
