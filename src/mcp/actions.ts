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
/** The longest note Standalone keeps on a gift (its `MAX_NOTE`); a longer one is refused there. */
export const MAX_NOTE = 2_000;
const isIanaTimeZone = (zone: string) => {
	try {
		Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
};
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

// openWorldHint is false: every tool talks only to the one connected site.
// destructiveHint false on a read matches the directory packet; the spec
// treats it as meaningful only when readOnlyHint is false.
const READ = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
// Creates a new record or link. Calling it again adds another.
const ADD = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
};
// The deployment replays these two when the arguments match, so a retry
// does not add a second campaign or gift.
const REPLAYS = {
	...ADD,
	idempotentHint: true,
};
// Sets fields to the values sent. The same call again leaves them as they are.
const SET = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
// Replaces or retires something donors can see. The same call again does not
// stack: the page is that block list, or the campaign is in that state.
const DESTRUCTIVE = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false,
};

const CONFIRMED =
	"Donors see this immediately, so the operator confirms it in the chat first.";
const replacesBlocks = (read: string) =>
	`A block left out is deleted. Each block follows a schema from get_block_catalog. ${read} returns the blocks that are there now.`;

/** One tool per `/connector/v1` action; each is registered on every server. */
export const ACTIONS = toolSpecs([
	{
		tool: "list_campaigns",
		action: "campaigns.list",
		title: "List campaigns",
		description:
			"Lists the site's campaigns with their status, public link, and id. For the amount raised, use get_results.",
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
			"Reads one campaign: settings, page blocks, status, and public link. For the amount raised, use get_results.",
		input: z.strictObject({ id }),
		annotations: READ,
	},
	{
		tool: "create_campaign",
		action: "campaigns.create",
		title: "Create a campaign",
		description:
			"Creates a draft campaign from the starting page. Donors cannot see a draft until it is published.",
		input: z.strictObject({ title: z.string().trim().min(1) }),
		annotations: REPLAYS,
		checkWith: "list_campaigns",
	},
	{
		tool: "update_campaign_blocks",
		action: "campaigns.update_blocks",
		title: "Edit a campaign's page",
		description: `Replaces every block on a campaign's page (heading, story, photos, goal meter, donation form), in order. ${replacesBlocks("get_campaign")}`,
		input: z.strictObject({ id, blocks }),
		annotations: DESTRUCTIVE,
		checkWith: "get_campaign",
	},
	{
		tool: "update_campaign_settings",
		action: "campaigns.update_settings",
		title: "Change a campaign's settings",
		description:
			"Sets a campaign's goal, end date, time zone, or the message and channels shown when it is shared. A field left out stays as it is. Null clears a field.",
		input: z.strictObject({
			id,
			goal: money.nullable().optional(),
			end_date: date.nullable().optional(),
			time_zone: z
				.string()
				.refine(isIanaTimeZone, "An IANA time zone, such as America/New_York.")
				.nullable()
				.optional(),
			sharing: z
				.strictObject({
					message: z.string().nullable().optional(),
					channels: z.array(z.string()).nullable().optional(),
				})
				.nullable()
				.optional(),
		}),
		annotations: SET,
		checkWith: "get_campaign",
	},
	{
		tool: "publish_campaign",
		action: "campaigns.publish",
		title: "Publish a campaign",
		description: `Puts a draft campaign live at its public link. The first publish requires gifts_go_to: ask the operator where the gifts go, then send a program id, or null for the general fund. ${CONFIRMED}`,
		input: z.strictObject({
			id,
			gifts_go_to: z.string().nullable().optional(),
		}),
		annotations: DESTRUCTIVE,
		checkWith: "get_campaign",
	},
	{
		tool: "unpublish_campaign",
		action: "campaigns.unpublish",
		title: "Unpublish a campaign",
		description: `Takes a published campaign back to draft. Its public link stops taking gifts. ${CONFIRMED}`,
		input: z.strictObject({ id }),
		annotations: DESTRUCTIVE,
		checkWith: "get_campaign",
	},
	{
		tool: "end_campaign",
		action: "campaigns.end",
		title: "End a campaign",
		description: `Ends a campaign for good. It stops taking gifts. ${CONFIRMED}`,
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
		description: `Replaces every block on the site's main donation page, in order. ${replacesBlocks("get_donation_page")}`,
		input: z.strictObject({ blocks }),
		annotations: DESTRUCTIVE,
		checkWith: "get_donation_page",
	},
	{
		tool: "reset_donation_page",
		action: "donation_page.reset",
		title: "Reset the donation page",
		description: `Puts the main donation page back to the starting page and discards its current blocks. ${CONFIRMED}`,
		input: z.strictObject({ confirm: z.literal(true) }),
		annotations: DESTRUCTIVE,
		checkWith: "get_donation_page",
	},
	{
		tool: "get_block_catalog",
		action: "blocks.catalog",
		title: "Get the block catalog",
		description:
			"Lists every block type a page can hold, with what it is for and its JSON Schema.",
		input: z.strictObject({}),
		annotations: READ,
	},
	{
		tool: "list_forms",
		action: "forms.list",
		title: "List donation forms",
		description:
			"Lists the site's donation forms (suggested amounts, currency, monthly giving), including each form's id. The list includes the donation page's form and each campaign's form; a campaign's form carries that campaign's campaign_id, and any other form has campaign_id null.",
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
			"Creates a donation form. The name is required. Other fields match the shape get_form returns.",
		input: z.looseObject({ name: z.string().trim().min(1) }),
		annotations: ADD,
		checkWith: "list_forms",
	},
	{
		tool: "update_form",
		action: "forms.update",
		title: "Edit a donation form",
		description:
			"Changes a donation form. Only the fields sent are changed, in the shape get_form returns. On a live form, a change donors would see needs confirm set to true, and only after the operator agrees.",
		input: z.looseObject({
			id,
			name: z.string().trim().min(1).optional(),
			confirm: z.literal(true).optional(),
		}),
		annotations: SET,
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
		description:
			"Lists gifts. Optionally limited to one campaign or a date range.",
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
			"Lists donors with their totals. q matches names and emails. Includes each donor's id.",
		input: z.strictObject({ q: z.string().optional(), ...page }),
		annotations: READ,
	},
	{
		tool: "get_donor",
		action: "donors.get",
		title: "Get a donor",
		description: "Reads one donor and a page of the gifts they have given.",
		input: z.strictObject({ id, ...page }),
		annotations: READ,
	},
	{
		tool: "list_recurring_gifts",
		action: "recurring.list",
		title: "List monthly gifts",
		description:
			"Lists recurring gifts. This connector cannot change a monthly gift.",
		input: z.strictObject({ ...page }),
		annotations: READ,
	},
	{
		tool: "record_donation",
		action: "donations.record",
		title: "Record a donation",
		description:
			"Records a donation already received offline, in cash or by check, so it counts in totals and the donor's history. It moves no money, charges no card, and issues no refund, and it is not tied to a campaign. To record a second gift with the same details, add a distinguishing note; the same details again match the earlier gift and record nothing new.",
		input: z.strictObject({
			amount: money,
			date,
			donor: z.strictObject({
				name: z.string().trim().min(1),
				email: z.email().optional(),
			}),
			method: z.enum(["cash", "check"]),
			note: z.string().trim().max(MAX_NOTE).optional(),
		}),
		annotations: REPLAYS,
		checkWith: "list_donations",
	},
	{
		tool: "create_photo_upload_link",
		action: "photos.upload_link",
		title: "Make a photo upload link",
		description:
			"Returns a short-lived, single-use link for adding a photo to a campaign or the donation page. The operator opens the link and chooses the photo. This connector does not upload the file.",
		input: z.strictObject({
			target: z.discriminatedUnion("kind", [
				z.strictObject({ kind: z.literal("campaign"), id }),
				z.strictObject({ kind: z.literal("donation_page") }),
			]),
			slot: z.string().optional(),
		}),
		annotations: ADD,
	},
]);
