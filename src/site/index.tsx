import type { Context } from "hono";
import { Hono } from "hono";
import { DocsPage } from "./docs";
import { ICON_PNG, ICON_SVG } from "./icon";
import { PrivacyPage } from "./privacy";
import { SupportPage } from "./support";
import { TermsPage } from "./terms";

const CSP = [
	"default-src 'none'",
	"style-src 'unsafe-inline'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

function pageHeaders(c: Context) {
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Content-Security-Policy", CSP);
}

/**
 * Directory pages, the placeholder icon, and OpenAI's domain-verification
 * token. `challenge` unset answers 404; the value is never logged.
 */
export function publicRoutes(challenge: string | undefined): Hono {
	const app = new Hono();
	app.get("/docs", (c) => {
		pageHeaders(c);
		return c.html(<DocsPage />);
	});
	app.get("/support", (c) => {
		pageHeaders(c);
		return c.html(<SupportPage />);
	});
	app.get("/privacy", (c) => {
		pageHeaders(c);
		return c.html(<PrivacyPage />);
	});
	app.get("/terms", (c) => {
		pageHeaders(c);
		return c.html(<TermsPage />);
	});
	app.get("/icon.svg", (c) => {
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Cache-Control", "public, max-age=86400");
		return c.body(ICON_SVG, 200, {
			"content-type": "image/svg+xml; charset=utf-8",
		});
	});
	app.get("/icon-512.png", (c) => {
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Cache-Control", "public, max-age=86400");
		// A copy: Hono's body type wants a Uint8Array backed by a plain ArrayBuffer.
		return c.body(new Uint8Array(ICON_PNG), 200, {
			"content-type": "image/png",
		});
	});
	app.get("/.well-known/openai-apps-challenge", (c) => {
		if (challenge === undefined) return c.body(null, 404);
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Cache-Control", "no-store");
		return c.text(challenge);
	});
	return app;
}
