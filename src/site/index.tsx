import type { Context } from "hono";
import { Hono } from "hono";
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

/** Directory pages, the placeholder icon, and the OpenAI domain challenge. */
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
