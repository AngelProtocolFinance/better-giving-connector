import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Connection } from "../db";
import {
	type CallAnswer,
	type DeploymentClient,
	DeploymentFailed,
	DeploymentRejected,
	isKeyedAction,
	KeyRefused,
	Moved,
	NeedsUpdate,
	Unreachable,
} from "../deployment";
import { log, type ToolOutcome } from "../log";
import type { Secret } from "../secret";
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
	return redactConnectionKey(result, connection.key);
}

// A deployment that echoes the connection key must not hand it to the chat.
// An empty key is not a pattern: splitting on it would rewrite the whole text.
function redactConnectionKey(
	result: CallToolResult,
	key: Secret,
): CallToolResult {
	const value = key.reveal();
	if (value.length === 0) return result;
	return {
		...result,
		content: result.content.map((part) =>
			part.type === "text" && part.text.includes(value)
				? { ...part, text: part.text.replaceAll(value, "[redacted]") }
				: part,
		),
	};
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
			result: { content: [{ type: "text", text: answerText(spec, answer) }] },
		};
	} catch (error) {
		// A throw out of here would reach the chat as its message, so whatever
		// `failure` can't word (its own drop included) is answered by `unexpected`.
		return await failure(error, spec, connection, ctx).catch((thrown) =>
			unexpected(thrown, spec, connection),
		);
	}
}

async function failure(
	error: unknown,
	spec: ActionSpec,
	connection: Connection,
	ctx: RunToolContext,
): Promise<Settled> {
	const org = connection.orgName;
	if (error instanceof KeyRefused) {
		await ctx.dropConnection(connection.userId);
		return said(
			"key_refused",
			`Better Giving at ${org} no longer accepts this connection. Reconnect Better Giving in your AI assistant's connector settings to keep going.`,
		);
	}
	if (error instanceof Moved) {
		await ctx.dropConnection(connection.userId);
		return said(
			"moved",
			`${org}'s Better Giving site has moved to a new address. Reconnect Better Giving in your AI assistant's connector settings and type the new address.`,
		);
	}
	if (error instanceof NeedsUpdate) {
		return said(
			"needs_update",
			`${org} can't do this through the connector yet. The other tools still work.`,
		);
	}
	if (error instanceof DeploymentFailed) {
		const problem = JSON.stringify(error.problem);
		const check = spec.checkWith
			? `It may or may not have been saved; check with ${spec.checkWith} before trying again.`
			: undefined;
		return said(
			"server_error",
			check === undefined ? problem : `${problem}\n\n${check}`,
		);
	}
	if (error instanceof DeploymentRejected) {
		return said(
			"rejected",
			error.problem
				? JSON.stringify(error.problem)
				: `${org}'s Better Giving refused this request.`,
		);
	}
	if (error instanceof Unreachable) {
		return said(
			"unreachable",
			unconfirmed(spec, org) ??
				`${org}'s donation site didn't answer. Try again in a moment.`,
		);
	}
	throw error;
}

function unexpected(
	error: unknown,
	spec: ActionSpec,
	connection: Connection,
): Settled {
	const errorName = error instanceof Error ? error.name : "unknown";
	log({ kind: "error", where: "mcp", errorName });
	return said(
		"failed",
		unconfirmed(spec, connection.orgName) ??
			"Something went wrong on Better Giving's side. Try again in a moment.",
	);
}

// A write whose answer was lost may still have landed on the deployment.
const unconfirmed = ({ checkWith }: ActionSpec, org: string) =>
	checkWith
		? `${org}'s donation site didn't confirm this. It may have gone through. Check with ${checkWith} before trying again.`
		: undefined;

const REPLAY_PREFIX =
	"Already done: this matches an earlier call with the same details, so nothing new was recorded. The original result follows.";

function answerText(spec: ActionSpec, answer: CallAnswer): string {
	const json = JSON.stringify(answer.body);
	if (isKeyedAction(spec.action) && answer.status === 200) {
		return `${REPLAY_PREFIX}\n${json}`;
	}
	return json;
}

const said = (outcome: ToolOutcome, text: string): Settled => ({
	outcome,
	result: { isError: true, content: [{ type: "text", text }] },
});
