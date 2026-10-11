import {
	bearerAuthChallengeResponse,
	createMcpHandler,
	getOAuthProtectedResourceMetadataUrl,
	McpServer,
	OAuthError,
	OAuthErrorCode,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import type { AuthFacade } from "../auth";
import {
	type Connection,
	ConnectionKeyUnreadable,
	type Connections,
} from "../db";
import type { DeploymentClient } from "../deployment";
import { ACTIONS } from "./actions";

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

	// An undecryptable key can never be used again, so the connection ends
	// here and the chat app's next sign-in makes a new one.
	async function connectionOf(userId: string): Promise<Connection | null> {
		try {
			return await deps.connections.get(userId);
		} catch (error) {
			if (!(error instanceof ConnectionKeyUnreadable)) throw error;
			await deps.auth.dropConnection(userId);
			return null;
		}
	}

	return new Hono().all("/", async (c) => {
		const who = await deps.auth.authenticateMcp(c.req.raw);
		if (!who) return signIn();
		const connection = await connectionOf(who.userId);
		if (!connection) return signIn();
		// Built per request: each server is bound to one caller's connection.
		const handler = createMcpHandler(() =>
			connectionServer(connection, deps.client),
		);
		return handler.fetch(c.req.raw);
	});
}

function connectionServer(
	connection: Connection,
	client: DeploymentClient,
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
				inputSchema: spec.input,
				annotations: spec.annotations,
			},
			async (input) => {
				const result = await client.call(connection, spec.action, input);
				return { content: [{ type: "text", text: JSON.stringify(result) }] };
			},
		);
	}
	return server;
}

function instructionsFor(orgName: string): string {
	return [
		`These tools act on ${JSON.stringify(orgName)}, the operator's live Better Giving donation site: what they change, donors see.`,
		"Before any publish, unpublish or end, say what will change and wait for the operator to say yes in this chat.",
	].join(" ");
}
