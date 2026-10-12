import {
	bearerAuthChallengeResponse,
	createMcpHandler,
	getOAuthProtectedResourceMetadataUrl,
	McpServer,
	OAuthError,
	OAuthErrorCode,
	originValidationResponse,
	type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import type { AuthFacade } from "../auth";
import {
	type Connection,
	ConnectionKeyUnreadable,
	type Connections,
} from "../db";
import type { DeploymentClient } from "../deployment";
import { log } from "../log";
import { ACTIONS, type ActionSpec } from "./actions";
import { type RunToolContext, runTool } from "./run-tool";

export type McpDeps = {
	auth: Pick<AuthFacade, "authenticateMcp" | "dropConnection">;
	connections: Connections;
	client: DeploymentClient;
	/** This endpoint's own URL, the resource its tokens are issued for. */
	resource: URL;
};

export function mcpRoute(deps: McpDeps): Hono {
	const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
		deps.resource,
	);
	const signIn = () =>
		bearerAuthChallengeResponse(
			new OAuthError(OAuthErrorCode.InvalidToken, "Sign in to Better Giving"),
			{ resourceMetadataUrl },
		);

	// A missing row or an undecryptable key can never be used again, so the
	// connection ends here, its tokens with it: the chat app's next refresh
	// fails and its sign-in makes a new one.
	async function connectionOf(userId: string): Promise<Connection | null> {
		try {
			const connection = await deps.connections.get(userId);
			if (connection) return connection;
		} catch (error) {
			if (!(error instanceof ConnectionKeyUnreadable)) throw error;
		}
		await deps.auth.dropConnection(userId);
		return null;
	}

	// Chat apps call from their servers and send no Origin, which passes; a
	// browser page on another site is refused before its bearer is read.
	const ownHost = [deps.resource.hostname];

	return new Hono().all("/", async (c) => {
		const foreign = originValidationResponse(c.req.raw, ownHost);
		if (foreign) return foreign;
		const who = await deps.auth.authenticateMcp(c.req.raw);
		if (!who) return signIn();
		const connection = await connectionOf(who.userId);
		if (!connection) return signIn();
		// Built per request, each bound to one caller's connection: the SDK's
		// per-request channel, AuthInfo, needs a clientId and scopes that
		// authenticateMcp doesn't return.
		const handler = createMcpHandler(
			() =>
				connectionServer(connection, {
					client: deps.client,
					dropConnection: deps.auth.dropConnection,
				}),
			{ onerror: logError },
		);
		return handler.fetch(c.req.raw);
	});
}

function connectionServer(
	connection: Connection,
	ctx: RunToolContext,
): McpServer {
	const server = new McpServer(
		{ name: "Better Giving", version: "1.0.0" },
		{
			capabilities: { tools: {} },
			instructions: instructionsFor(connection.orgName),
		},
	);
	for (const spec of ACTIONS) {
		server.registerTool(
			spec.tool,
			{
				title: spec.title,
				description: spec.description,
				inputSchema: loggedInput(spec),
				annotations: spec.annotations,
			},
			(input) => runTool(spec, connection, input, ctx),
		);
	}
	return server;
}

// The name only: the SDK's messages quote the request.
const logError = (error: Error) =>
	log({ kind: "error", where: "mcp", errorName: error.name });

// The SDK answers a call its schema refuses before runTool runs, so that
// refusal is logged here, where the schema runs.
function loggedInput(
	spec: ActionSpec,
): StandardSchemaWithJSON<Record<string, unknown>> {
	const schema = spec.input["~standard"];
	return {
		"~standard": {
			...schema,
			async validate(value) {
				const started = performance.now();
				const result = await schema.validate(value);
				if (result.issues) {
					const ms = Math.round(performance.now() - started);
					log({
						kind: "tool",
						tool: spec.action,
						outcome: "invalid_input",
						ms,
					});
				}
				return result;
			},
		},
	};
}

function instructionsFor(orgName: string): string {
	return [
		`These tools act on ${JSON.stringify(orgName)}, the operator's live Better Giving donation site: what they change, donors see.`,
		"Before publish_campaign, unpublish_campaign, end_campaign or reset_donation_page, say what will change and wait for the operator's explicit yes in this chat.",
	].join(" ");
}
