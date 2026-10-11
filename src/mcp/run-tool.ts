import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Connection } from "../db";
import {
	type DeploymentClient,
	DeploymentRejected,
	KeyRefused,
	NeedsUpdate,
	Unreachable,
} from "../deployment";
import { log, type ToolOutcome } from "../log";
import type { ActionSpec } from "./actions";

export type RunToolContext = {
	client: Pick<DeploymentClient, "call">;
	dropConnection(userId: string): Promise<void>;
};

type Settled = { outcome: ToolOutcome; result: CallToolResult };

/**
 * Runs one tool call on the connection's deployment. The one place a
 * deployment's failure becomes the sentence the chat shows; it never throws.
 */
export async function runTool(
	spec: ActionSpec,
	connection: Connection,
	input: Record<string, unknown>,
	ctx: RunToolContext,
): Promise<CallToolResult> {
	const started = performance.now();
	const { outcome, result } = await settle(spec, connection, input, ctx);
	const ms = Math.round(performance.now() - started);
	log({ kind: "tool", tool: spec.action, outcome, ms });
	return result;
}

async function settle(
	spec: ActionSpec,
	connection: Connection,
	input: Record<string, unknown>,
	ctx: RunToolContext,
): Promise<Settled> {
	try {
		const answer = await ctx.client.call(connection, spec.action, input);
		return {
			outcome: "ok",
			result: {
				structuredContent: answer as Record<string, unknown>,
				content: [{ type: "text", text: JSON.stringify(answer) }],
			},
		};
	} catch (error) {
		// A throw out of here would reach the chat as its message, so whatever
		// `failure` can't word (its own drop included) ends as the generic answer.
		return await failure(error, connection, ctx).catch(unexpected);
	}
}

async function failure(
	error: unknown,
	connection: Connection,
	ctx: RunToolContext,
): Promise<Settled> {
	const org = connection.orgName;
	if (error instanceof KeyRefused) {
		await ctx.dropConnection(connection.userId);
		return said(
			"key_refused",
			`Better Giving at ${org} no longer accepts this connection — it was disconnected from the dashboard. Reconnect Better Giving in this app's connector settings to keep going.`,
		);
	}
	if (error instanceof NeedsUpdate) {
		return said(
			"needs_update",
			`${org}'s Better Giving doesn't support this yet. Update Better Giving to the latest release, then try again.`,
		);
	}
	if (error instanceof DeploymentRejected) {
		const found = problem.safeParse(error.body).data;
		const isProblem =
			found && Object.values(found).some((v) => v !== undefined);
		return said(
			"rejected",
			isProblem
				? JSON.stringify(found)
				: `${org}'s Better Giving refused this request.`,
		);
	}
	if (error instanceof Unreachable) {
		return said(
			"unreachable",
			`${org}'s donation site didn't answer. Try again in a moment.`,
		);
	}
	throw error;
}

function unexpected(error: unknown): Settled {
	const errorName = error instanceof Error ? error.name : "unknown";
	log({ kind: "error", where: "mcp", errorName });
	return said(
		"failed",
		"Something went wrong on Better Giving's side. Try again in a moment.",
	);
}

// What of an RFC 9457 problem the model can act on; anything else in the body
// stays behind, and a malformed field is dropped rather than failing the rest.
const problem = z.object({
	title: z.string().optional().catch(undefined),
	detail: z.string().optional().catch(undefined),
	code: z.string().optional().catch(undefined),
	errors: z
		.array(z.object({ path: z.string(), message: z.string() }))
		.optional()
		.catch(undefined),
});

const said = (outcome: ToolOutcome, text: string): Settled => ({
	outcome,
	result: { isError: true, content: [{ type: "text", text }] },
});
