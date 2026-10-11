import { z } from "zod";

// Mirror of `/connector/v1` as `better-giving-oss` owns it
// (plan/connector/contract.md there). When that contract moves, this file moves.

export const BASE_PATH = "/connector/v1";
export const ALLOW_PATH = "/admin/connector/allow";

export const ACTIONS = {
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

export type ActionName = keyof typeof ACTIONS;

const isActionName = (name: string): name is ActionName =>
	Object.hasOwn(ACTIONS, name);

// Unknown fields and action names are ignored, never thrown on.
export const helloBody = z
	.object({
		service: z.literal("better-giving"),
		contract: z.literal(1),
		release: z.string(),
		name: z.string(),
		actions: z.array(z.string()),
	})
	.transform(({ release, name, actions }) => ({
		release,
		orgName: name,
		actions: actions.filter(isActionName),
	}));

export const exchangeBody = z.object({ key: z.string().min(1) });

// The `code` of an RFC 9457 problem body, when there is one.
export const problemCode = z.object({ code: z.string() });
