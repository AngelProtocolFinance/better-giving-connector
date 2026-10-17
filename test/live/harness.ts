import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Connection } from "../../src/db";
import { deploymentClient } from "../../src/deployment";
import { parseOrigin } from "../../src/deployment/origin";
import { ACTIONS, type ActionSpec } from "../../src/mcp/actions";
import { type RunToolContext, runTool } from "../../src/mcp/run-tool";
import { MVP_ACTIONS } from "../fake-deployment";

const REPLAY =
	"Already done: this matches an earlier call with the same details, so nothing new was recorded. The original result follows.";
const UNKNOWN = "can't do this through the connector yet";
const REFUSED = "no longer accepts this connection";

const MVP = new Set<string>(MVP_ACTIONS);

export type LiveRow = {
	tool: string;
	outcome: "ok" | "replay" | "unknown_action" | "key_refused" | "error";
	ms: number;
	bytes: number;
};

export type LiveHarnessOptions = {
	origin: string;
	code: string;
	fetch: typeof fetch;
	/** Overwritten with one JSON line per tool: tool, outcome, ms, bytes. */
	resultsPath: string;
	now?: Date;
};

/**
 * Hello, exchange, the 13 minimum tools (create and record twice), the other
 * 10 as actions this deployment does not serve, then disconnect and one refused
 * call. The results file never receives arguments, response bodies, or the key.
 */
export async function runLiveHarness(opts: LiveHarnessOptions): Promise<void> {
	const rows: LiveRow[] = [];
	try {
		const origin = parseOrigin(opts.origin);
		if (!origin) throw new Error("origin is not a public https origin");
		const client = deploymentClient({ fetch: opts.fetch });
		const hello = await client.hello(origin);
		const exchanged = await client.exchange(hello.origin, opts.code);
		const connection: Connection = {
			userId: "live-harness",
			origin: hello.origin,
			orgName: hello.orgName,
			key: exchanged.key,
			createdAt: opts.now ?? new Date(),
		};
		let dropped = false;
		const ctx: RunToolContext = {
			client,
			dropConnection: async () => {
				dropped = true;
			},
		};
		const now = opts.now ?? new Date();
		const stamp = `connector live test ${now.toISOString()}`;
		const day = now.toISOString().slice(0, 10);
		const ids = { campaign: "", form: "", donor: "" };

		const mvp = ACTIONS.filter((spec) => MVP.has(spec.action));
		const rest = ACTIONS.filter((spec) => !MVP.has(spec.action));
		if (mvp.length !== 13 || rest.length !== 10) {
			throw new Error(
				"the connector does not list 13 minimum tools and 10 others",
			);
		}

		const created = await run(rows, ctx, connection, "create_campaign", {
			title: stamp,
		});
		await run(rows, ctx, connection, "create_campaign", { title: stamp });
		expectOutcome(rows.at(-2), "create_campaign", "ok");
		expectOutcome(rows.at(-1), "create_campaign", "replay");
		ids.campaign = stringField(created, (value) => value.id, "create_campaign");

		for (const tool of [
			"list_campaigns",
			"get_campaign",
			"get_donation_page",
			"get_block_catalog",
			"list_forms",
		] as const) {
			const text = await run(
				rows,
				ctx,
				connection,
				tool,
				minimumArgs(tool, ids),
			);
			expectOutcome(rows.at(-1), tool, "ok");
			if (tool === "list_forms") {
				ids.form = stringField(
					text,
					(value) => {
						const data = value.data;
						if (!Array.isArray(data)) return undefined;
						const first = data[0];
						if (typeof first !== "object" || first === null) return undefined;
						return (first as { id?: unknown }).id;
					},
					"list_forms",
				);
			}
		}

		await run(rows, ctx, connection, "get_form", { id: ids.form });
		expectOutcome(rows.at(-1), "get_form", "ok");
		for (const tool of [
			"get_results",
			"list_donations",
			"list_donors",
		] as const) {
			await run(rows, ctx, connection, tool, {});
			expectOutcome(rows.at(-1), tool, "ok");
		}

		const recorded = await run(
			rows,
			ctx,
			connection,
			"record_donation",
			gift(stamp, day),
		);
		await run(rows, ctx, connection, "record_donation", gift(stamp, day));
		expectOutcome(rows.at(-2), "record_donation", "ok");
		expectOutcome(rows.at(-1), "record_donation", "replay");
		ids.donor = stringField(
			recorded,
			(value) => value.donor_id,
			"record_donation",
		);

		await run(rows, ctx, connection, "get_donor", { id: ids.donor, limit: 5 });
		expectOutcome(rows.at(-1), "get_donor", "ok");
		await run(rows, ctx, connection, "list_recurring_gifts", {});
		expectOutcome(rows.at(-1), "list_recurring_gifts", "ok");
		if (dropped) throw new Error("a minimum tool dropped the connection");

		for (const spec of rest) {
			await run(
				rows,
				ctx,
				connection,
				spec.tool,
				otherArgs(spec.tool, ids, stamp, day),
			);
			expectOutcome(rows.at(-1), spec.tool, "unknown_action");
		}
		if (dropped) throw new Error("an unknown action dropped the connection");

		await client.disconnect(connection);
		await run(rows, ctx, connection, "list_campaigns", {});
		expectOutcome(rows.at(-1), "list_campaigns", "key_refused");
	} finally {
		await mkdir(dirname(opts.resultsPath), { recursive: true });
		const body = rows.map((row) => JSON.stringify(row)).join("\n");
		await writeFile(opts.resultsPath, body === "" ? "" : `${body}\n`);
	}
}

function gift(stamp: string, day: string): Record<string, unknown> {
	return {
		amount: { amount: "1.00", currency: "USD" },
		date: day,
		donor: { name: stamp },
		method: "cash",
		note: stamp,
	};
}

function minimumArgs(
	tool: string,
	ids: { campaign: string },
): Record<string, unknown> {
	if (tool === "get_campaign") return { id: ids.campaign };
	return {};
}

function otherArgs(
	tool: string,
	ids: { campaign: string; form: string },
	stamp: string,
	day: string,
): Record<string, unknown> {
	switch (tool) {
		case "update_campaign_blocks":
			return { id: ids.campaign, blocks: [] };
		case "update_campaign_settings":
			return { id: ids.campaign, end_date: day };
		case "publish_campaign":
			return { id: ids.campaign, gifts_go_to: null };
		case "unpublish_campaign":
		case "end_campaign":
			return { id: ids.campaign };
		case "update_donation_page_blocks":
			return { blocks: [] };
		case "reset_donation_page":
			return { confirm: true };
		case "create_form":
			return { name: stamp };
		case "update_form":
			return { id: ids.form, name: stamp };
		case "create_photo_upload_link":
			return { target: { kind: "donation_page" } };
		default:
			return {};
	}
}

async function run(
	rows: LiveRow[],
	ctx: RunToolContext,
	connection: Connection,
	tool: string,
	args: Record<string, unknown>,
): Promise<string> {
	const spec = specNamed(tool);
	const started = performance.now();
	const result = await runTool(spec, connection, args, ctx);
	const text = result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n");
	rows.push({
		tool: spec.tool,
		outcome: outcomeOf(text, result.isError),
		ms: Math.round(performance.now() - started),
		bytes: Buffer.byteLength(text),
	});
	return text;
}

const specNamed = (tool: string): ActionSpec => {
	const spec = ACTIONS.find((item) => item.tool === tool);
	if (!spec) throw new Error(`no tool ${tool}`);
	return spec;
};

function outcomeOf(
	text: string,
	isError: boolean | undefined,
): LiveRow["outcome"] {
	if (text.startsWith(REPLAY)) return "replay";
	if (text.includes(UNKNOWN)) return "unknown_action";
	if (text.includes(REFUSED)) return "key_refused";
	if (isError === true) return "error";
	return "ok";
}

function expectOutcome(
	row: LiveRow | undefined,
	tool: string,
	outcome: LiveRow["outcome"],
): void {
	if (!row || row.tool !== tool || row.outcome !== outcome) {
		throw new Error(
			`${tool} returned ${row?.outcome ?? "nothing"}, expected ${outcome}`,
		);
	}
}

function stringField(
	text: string,
	read: (value: Record<string, unknown>) => unknown,
	label: string,
): string {
	let parsed: unknown;
	try {
		const json = text.startsWith(REPLAY) ? text.slice(REPLAY.length + 1) : text;
		parsed = JSON.parse(json);
	} catch {
		throw new Error(`${label} was not json`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`${label} returned no id`);
	}
	const value = read(parsed as Record<string, unknown>);
	if (typeof value !== "string" || value === "") {
		throw new Error(`${label} returned no id`);
	}
	return value;
}
