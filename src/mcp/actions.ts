import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ActionName } from "../deployment";

export type ActionSpec<Tool extends string = string> = {
	tool: Tool;
	action: ActionName;
	title: string;
	description: string;
	input: z.ZodObject;
	annotations: ToolAnnotations;
	/** A write's read tool: what shows whether it went through when its answer was lost. */
	checkWith?: NoInfer<Tool>;
};

// Tool is inferred from the specs' `tool` names alone, so a `checkWith`
// naming no tool is a type error.
const toolSpecs = <const Tool extends string>(
	specs: readonly ActionSpec<Tool>[],
) => specs;

// Ids fill path segments. Encoding leaves "." and ".." as they are and URL
// parsing resolves them onto another route; "/" is encoded, and refused in case
// the deployment decodes %2F before routing.
const id = z
	.string()
	.min(1)
	.regex(/^(?!\.\.?$)[^/]+$/, "An id is never '.', '..' or contains '/'.");
const date = z.iso.date();
const money = z.strictObject({
	amount: z
		.string()
		.regex(/^\d+(\.\d{1,2})?$/, 'A decimal string such as "25.00".'),
	currency: z.literal("USD"),
});
const page = {
	cursor: z
		.string()
		.optional()
		.describe("The next_cursor of the previous page."),
	limit: z.int().min(1).max(100).optional(),
};
const blocks = z
	.array(z.record(z.string(), z.unknown()))
	.describe(
		"The whole block list, in order. Each block's shape is in get_block_catalog.",
	);

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	openWorldHint: false,
};
// Publish, unpublish, end and reset also wait for a yes, in their descriptions.
const DESTRUCTIVE = {
	readOnlyHint: false,
	destructiveHint: true,
	openWorldHint: false,
};

const WAIT_FOR_YES =
	"Donors see this at once: first tell the operator what will change, ask, and call this only after they say yes in this chat.";
const replacesBlocks = (read: string) =>
	`Read the current blocks with ${read} first and send back every block you aren't changing, in order; any left out are deleted. Build each block to its schema from get_block_catalog.`;

/** One tool per `/connector/v1` action; each is registered on every server. */
export const ACTIONS = toolSpecs([
	{
		tool: "list_campaigns",
		action: "campaigns.list",
		title: "List campaigns",
		description:
			"Lists the site's campaigns with their status, public link and amount raised. Use it to find a campaign's id.",
		input: z.strictObject({
			status: z.enum(["draft", "published", "ended"]).optional(),
			...page,
		}),
		annotations: READ,
	},
	{
		tool: "get_campaign",
		action: "campaigns.get",
		title: "Get a campaign",
		description:
			"Reads one campaign in full: settings, page blocks, status, public link and amount raised.",
		input: z.strictObject({ id }),
		annotations: READ,
	},
	{
		tool: "create_campaign",
		action: "campaigns.create",
		title: "Create a campaign",
		description:
			"Creates a draft campaign from the starting page. Donors can't see it until it is published.",
		input: z.strictObject({ title: z.string().trim().min(1) }),
		annotations: WRITE,
		checkWith: "list_campaigns",
	},
	{
		tool: "update_campaign_blocks",
		action: "campaigns.update_blocks",
		title: "Edit a campaign's page",
		description: `Replaces the blocks of a campaign's page (heading, story, photos, goal meter, donation form). ${replacesBlocks("get_campaign")}`,
		input: z.strictObject({ id, blocks }),
		annotations: DESTRUCTIVE,
		checkWith: "get_campaign",
	},
	{
		tool: "update_campaign_settings",
		action: "campaigns.update_settings",
		title: "Change a campaign's settings",
		description:
			"Sets a campaign's goal, end date, or the title and description shown when it is shared. Fields left out stay as they are; null clears one.",
		input: z.strictObject({
			id,
			goal: money.nullable().optional(),
			end_date: date.nullable().optional(),
			sharing: z
				.strictObject({
					title: z.string().nullable().optional(),
					description: z.string().nullable().optional(),
				})
				.optional(),
		}),
		annotations: WRITE,
		checkWith: "get_campaign",
	},
	{
		tool: "publish_campaign",
		action: "campaigns.publish",
		title: "Publish a campaign",
		description: `Puts a draft campaign live at its public link. ${WAIT_FOR_YES}`,
		input: z.strictObject({ id }),
		annotations: DESTRUCTIVE,
		checkWith: "get_campaign",
	},
	{
		tool: "unpublish_campaign",
		action: "campaigns.unpublish",
		title: "Unpublish a campaign",
		description: `Takes a published campaign back to draft; its public link stops taking gifts. ${WAIT_FOR_YES}`,
		input: z.strictObject({ id }),
		annotations: DESTRUCTIVE,
		checkWith: "get_campaign",
	},
	{
		tool: "end_campaign",
		action: "campaigns.end",
		title: "End a campaign",
		description: `Ends a campaign for good; it stops taking gifts. ${WAIT_FOR_YES}`,
		input: z.strictObject({ id }),
		annotations: DESTRUCTIVE,
		checkWith: "get_campaign",
	},
	{
		tool: "get_donation_page",
		action: "donation_page.get",
		title: "Get the donation page",
		description:
			"Reads the site's main donation page: its blocks and public link.",
		input: z.strictObject({}),
		annotations: READ,
	},
	{
		tool: "update_donation_page_blocks",
		action: "donation_page.update_blocks",
		title: "Edit the donation page",
		description: `Replaces the blocks of the site's main donation page. ${replacesBlocks("get_donation_page")}`,
		input: z.strictObject({ blocks }),
		annotations: DESTRUCTIVE,
		checkWith: "get_donation_page",
	},
	{
		tool: "reset_donation_page",
		action: "donation_page.reset",
		title: "Reset the donation page",
		description: `Puts the main donation page back to the starting page, discarding its current blocks. ${WAIT_FOR_YES}`,
		input: z.strictObject({}),
		annotations: DESTRUCTIVE,
		checkWith: "get_donation_page",
	},
	{
		tool: "get_block_catalog",
		action: "blocks.catalog",
		title: "Get the block catalog",
		description:
			"Lists every block type a page can hold, with what it is for and its JSON Schema. Read it before editing any page's blocks.",
		input: z.strictObject({}),
		annotations: READ,
	},
	{
		tool: "list_forms",
		action: "forms.list",
		title: "List donation forms",
		description:
			"Lists the site's donation forms (suggested amounts, currency, monthly giving). Use it to find a form's id.",
		input: z.strictObject({ ...page }),
		annotations: READ,
	},
	{
		tool: "get_form",
		action: "forms.get",
		title: "Get a donation form",
		description: "Reads one donation form in full.",
		input: z.strictObject({ id }),
		annotations: READ,
	},
	{
		tool: "create_form",
		action: "forms.create",
		title: "Create a donation form",
		description:
			"Creates a donation form. Give it a name, plus any form fields as get_form shows them.",
		input: z.looseObject({ name: z.string().trim().min(1) }),
		annotations: WRITE,
		checkWith: "list_forms",
	},
	{
		tool: "update_form",
		action: "forms.update",
		title: "Edit a donation form",
		description:
			"Changes a donation form. Send only the fields to change, as get_form shows them.",
		input: z.looseObject({ id, name: z.string().trim().min(1).optional() }),
		annotations: WRITE,
		checkWith: "get_form",
	},
	{
		tool: "get_results",
		action: "results.summary",
		title: "Get fundraising results",
		description:
			"Totals raised, gift count, donor count and per-campaign totals, optionally for one campaign or a date range.",
		input: z.strictObject({
			campaign_id: id.optional(),
			from: date.optional(),
			to: date.optional(),
		}),
		annotations: READ,
	},
	{
		tool: "list_donations",
		action: "donations.list",
		title: "List donations",
		description: "Lists gifts, optionally for one campaign or a date range.",
		input: z.strictObject({
			campaign_id: id.optional(),
			from: date.optional(),
			to: date.optional(),
			...page,
		}),
		annotations: READ,
	},
	{
		tool: "list_donors",
		action: "donors.list",
		title: "List donors",
		description:
			"Lists donors with their totals; q searches names and emails. Use it to find a donor's id.",
		input: z.strictObject({ q: z.string().optional(), ...page }),
		annotations: READ,
	},
	{
		tool: "get_donor",
		action: "donors.get",
		title: "Get a donor",
		description: "Reads one donor with every gift they have given.",
		input: z.strictObject({ id }),
		annotations: READ,
	},
	{
		tool: "list_recurring_gifts",
		action: "recurring.list",
		title: "List monthly gifts",
		description:
			"Lists recurring gifts. Read only: monthly gifts can't be changed from here.",
		input: z.strictObject({ ...page }),
		annotations: READ,
	},
	{
		tool: "record_donation",
		action: "donations.record",
		title: "Record a donation",
		description:
			"Records a gift received outside the site (cash, check, bank transfer), optionally toward a campaign. It counts in totals and the donor's history.",
		input: z.strictObject({
			amount: money,
			date,
			donor: z.strictObject({
				name: z.string().trim().min(1),
				email: z.email().optional(),
			}),
			campaign_id: id.optional(),
			method: z.enum(["cash", "check", "bank_transfer", "other"]),
			note: z.string().optional(),
		}),
		annotations: WRITE,
		checkWith: "list_donations",
	},
	{
		tool: "create_photo_upload_link",
		action: "photos.upload_link",
		title: "Make a photo upload link",
		description:
			"Makes a short-lived, single-use link for adding a photo to a campaign or the donation page. Hand the link to the operator to open on their phone and pick the photo; you can't upload it yourself.",
		input: z.strictObject({
			target: z.discriminatedUnion("kind", [
				z.strictObject({ kind: z.literal("campaign"), id }),
				z.strictObject({ kind: z.literal("donation_page") }),
			]),
			slot: z.string().optional(),
		}),
		annotations: WRITE,
	},
]);
