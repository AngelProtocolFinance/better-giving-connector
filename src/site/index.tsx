import type { Context } from "hono";
import { Hono } from "hono";
import demoMp4 from "./demo.mp4";
import { DocsPage } from "./docs";
import { ICON_SVG, iconPng } from "./icon";
import { PrivacyPage } from "./privacy";
import { SupportPage } from "./support";
import { TermsPage } from "./terms";

export type SiteDeps = {
	/** OpenAI's domain-verification token. Unset answers 404. */
	challenge: string | undefined;
};

const HTML_HEADERS = {
	"content-security-policy": "frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
	"cache-control": "no-cache",
} as const;

function html(c: Context, body: string | Promise<string>) {
	for (const [name, value] of Object.entries(HTML_HEADERS))
		c.header(name, value);
	return c.html(body);
}

const DEMO_CAPTIONS = `WEBVTT

00:00:00.000 --> 00:00:08.000
MCP test client. Connect a site, then five tools and three refusals.

00:00:08.000 --> 00:00:20.000
Connect. Enter the donation site and continue.

00:00:20.000 --> 00:00:30.000
Sign in at better.giving, or on your own Better Giving site.

00:00:30.000 --> 00:00:36.000
Allow the connector for this organisation.

00:00:36.000 --> 00:00:44.000
Connected. Publishing waits for an explicit yes.

00:00:44.000 --> 00:00:52.000
list_campaigns. Campaigns on the connected site.

00:00:52.000 --> 00:01:00.000
get_results. Fundraising totals.

00:01:00.000 --> 00:01:16.000
create_campaign. A draft named Spring Drive.

00:01:16.000 --> 00:01:24.000
record_donation. An offline cash gift. No money moves.

00:01:24.000 --> 00:01:32.000
list_donors. Donors on the connected site.

00:01:32.000 --> 00:01:48.000
Refused. The donation amount is not a valid input.

00:01:48.000 --> 00:01:56.000
Refused. Publishing was not confirmed, so it was not called.

00:01:56.000 --> 00:02:12.000
Refused. A refund is out of scope. The connector moves no money.
`;

function owned(view: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(view.byteLength);
	copy.set(view);
	return copy;
}

const VIDEO_HEADERS = {
	"content-type": "video/mp4",
	"x-content-type-options": "nosniff",
	"accept-ranges": "bytes",
	"cache-control": "public, max-age=3600",
} as const;

/** `bytes=start-end`, inclusive. `bad` is a Range this file cannot satisfy. */
function byteRange(
	header: string | undefined,
	size: number,
): { start: number; end: number } | "none" | "bad" {
	if (header === undefined) return "none";
	const match = /^bytes=(\d+)-(\d*)$/.exec(header);
	if (match === null) return "bad";
	const start = Number(match[1]);
	const endText = match[2] ?? "";
	const end = endText === "" ? size - 1 : Number(endText);
	if (!Number.isInteger(start) || !Number.isInteger(end)) return "bad";
	if (start < 0 || end < start || end >= size) return "bad";
	return { start, end };
}

function demoResponse(c: Context, bytes: Uint8Array<ArrayBuffer>) {
	const ranged = byteRange(c.req.header("range"), bytes.byteLength);
	if (ranged === "bad") {
		return c.body(null, 416, {
			...VIDEO_HEADERS,
			"content-range": `bytes */${bytes.byteLength}`,
		});
	}
	if (ranged === "none") {
		return c.body(bytes, 200, {
			...VIDEO_HEADERS,
			"content-length": String(bytes.byteLength),
		});
	}
	const slice = owned(bytes.subarray(ranged.start, ranged.end + 1));
	return c.body(slice, 206, {
		...VIDEO_HEADERS,
		"content-range": `bytes ${ranged.start}-${ranged.end}/${bytes.byteLength}`,
		"content-length": String(slice.byteLength),
	});
}

/** Directory pages, the Better Giving logo, and the OpenAI domain challenge. */
export function siteRoutes(deps: SiteDeps): Hono {
	const app = new Hono();
	app.get("/privacy", (c) => html(c, <PrivacyPage />));
	app.get("/terms", (c) => html(c, <TermsPage />));
	app.get("/docs", (c) => html(c, <DocsPage />));
	app.get("/support", (c) => html(c, <SupportPage />));
	app.get("/icon.svg", (c) =>
		c.body(ICON_SVG, 200, {
			"content-type": "image/svg+xml; charset=utf-8",
			"x-content-type-options": "nosniff",
			"cache-control": "public, max-age=3600",
		}),
	);
	app.get("/icon-512.png", (c) =>
		c.body(iconPng(), 200, {
			"content-type": "image/png",
			"x-content-type-options": "nosniff",
			"cache-control": "public, max-age=3600",
		}),
	);
	app.get("/demo.mp4", (c) => demoResponse(c, demoMp4));
	app.get("/demo.vtt", (c) =>
		c.body(DEMO_CAPTIONS, 200, {
			"content-type": "text/vtt; charset=utf-8",
			"x-content-type-options": "nosniff",
			"cache-control": "public, max-age=3600",
		}),
	);
	// Plain text, exact token, no store: a cached 404 would outlive the env var.
	app.get("/.well-known/openai-apps-challenge", (c) => {
		if (deps.challenge === undefined) {
			return c.body(null, 404, { "cache-control": "no-store" });
		}
		return c.body(deps.challenge, 200, {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
		});
	});
	return app;
}
