import { z } from "zod";

// Mirror of `/connector/v1` as `better-giving-oss` owns it
// (plan/connector/contract.md there). When that contract moves, this file moves.

export const BASE_PATH = "/connector/v1";
export const ALLOW_PATH = "/admin/connector/allow";

export const ROUTES = {
	"campaigns.list": { method: "GET", path: "/campaigns" },
	"campaigns.get": { method: "GET", path: "/campaigns/:id" },
	"campaigns.create": { method: "POST", path: "/campaigns" },
	"campaigns.update_blocks": { method: "PATCH", path: "/campaigns/:id/blocks" },
	"campaigns.update_settings": {
		method: "PATCH",
		path: "/campaigns/:id/settings",
	},
	"campaigns.publish": { method: "POST", path: "/campaigns/:id/publish" },
	"campaigns.unpublish": { method: "POST", path: "/campaigns/:id/unpublish" },
	"campaigns.end": { method: "POST", path: "/campaigns/:id/end" },
	"donation_page.get": { method: "GET", path: "/donation-page" },
	"donation_page.update_blocks": {
		method: "PATCH",
		path: "/donation-page/blocks",
	},
	"donation_page.reset": { method: "POST", path: "/donation-page/reset" },
	"blocks.catalog": { method: "GET", path: "/blocks/catalog" },
	"forms.list": { method: "GET", path: "/forms" },
	"forms.get": { method: "GET", path: "/forms/:id" },
	"forms.create": { method: "POST", path: "/forms" },
	"forms.update": { method: "PATCH", path: "/forms/:id" },
	"results.summary": { method: "GET", path: "/results" },
	"donations.list": { method: "GET", path: "/donations" },
	"donors.list": { method: "GET", path: "/donors" },
	"donors.get": { method: "GET", path: "/donors/:id" },
	"recurring.list": { method: "GET", path: "/recurring" },
	"donations.record": { method: "POST", path: "/donations" },
	"photos.upload_link": { method: "POST", path: "/photos/upload-link" },
} as const satisfies Record<
	string,
	{ method: "GET" | "POST" | "PATCH"; path: string }
>;

export type ActionName = keyof typeof ROUTES;

export const isActionName = (name: string): name is ActionName =>
	Object.hasOwn(ROUTES, name);

const ORG_NAME_MAX = 100;

// The deployment writes the org name, and it reaches the model's instructions
// and every error sentence, so it arrives as one line of bounded length; empty
// when nothing is left, for hello to fill. Cut by code point, so never inside
// a surrogate pair.
const orgName = (name: string) =>
	Array.from(
		name
			.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
			.replace(/\s+/g, " ")
			.trim(),
	)
		.slice(0, ORG_NAME_MAX)
		.join("")
		.trim();

// Unknown fields are ignored, never thrown on.
export const helloBody = z
	.object({
		service: z.literal("better-giving"),
		contract: z.literal(1),
		release: z.string(),
		name: z.string(),
	})
	.transform(({ release, name }) => ({ release, orgName: orgName(name) }));

export const exchangeBody = z.object({ key: z.string().min(1) });

/** What of an RFC 9457 problem body the chat can act on. */
export type Problem = {
	title?: string;
	detail?: string;
	code?: string;
	errors?: { path: string; message: string }[];
};

// Anything else in the body stays behind, and a malformed field is dropped
// rather than failing the rest.
const problemFields = z.object({
	title: z.string().optional().catch(undefined),
	detail: z.string().optional().catch(undefined),
	code: z.string().optional().catch(undefined),
	errors: z
		.array(z.object({ path: z.string(), message: z.string() }))
		.optional()
		.catch(undefined),
});

/** The problem in a response body, or null when the body holds none. */
export function problemOf(body: unknown): Problem | null {
	const fields = problemFields.safeParse(body).data ?? {};
	const kept = Object.entries(fields).filter(([, v]) => v !== undefined);
	return kept.length > 0 ? (Object.fromEntries(kept) as Problem) : null;
}
