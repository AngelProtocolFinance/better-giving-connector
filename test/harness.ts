import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import type { Env } from "../src/env";
import type { Call } from "./oauth";

export const BASE = "https://connect.example";

export const env: Env = {
	PUBLIC_URL: BASE,
	TURSO_DATABASE_URL: "file::memory:",
	BETTER_AUTH_SECRET: "test-better-auth-secret-aaaaaaaaaaaaaaaa",
	CONNECTION_KEY_SECRET: "test-connection-key-secret-aaaaaaaaaaaa",
	CRON_SECRET: "test-cron-secret-aaaaaaaaaaaaaaaaaaaaaaa",
};

// better-auth seeds its tables while it starts; a test that never
// reaches auth would otherwise close the database under that write.
export const warmUp = (request: Call) =>
	request(new Request(`${BASE}/.well-known/oauth-protected-resource`));

export function mcpPost(
	body: unknown,
	authorization?: string,
	headers: Record<string, string> = {},
): Request {
	return new Request(`${BASE}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(authorization ? { authorization } : {}),
			...headers,
		},
		body: JSON.stringify(body),
	});
}

const CLIENT_INFO = { name: "chat-app", version: "1.0.0" };

export const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: CLIENT_INFO,
	},
};

/** The MCP versions chat apps speak to /mcp: the current one, and the 2025 one still in use. */
export const MCP_VERSIONS = ["2026-07-28", "2025-06-18"] as const;
export type McpVersion = (typeof MCP_VERSIONS)[number];

/**
 * A JSON-RPC request as a chat app speaking `version` sends it. From
 * 2026-07-28 every request carries its version and the client in `_meta`, and
 * its method (and a tool call's name) again in headers.
 */
export function mcpRequest(
	version: McpVersion,
	authorization: string | undefined,
	method: string,
	params?: Record<string, unknown>,
	id = 1,
): Request {
	if (version === "2025-06-18") {
		return mcpPost({ jsonrpc: "2.0", id, method, params }, authorization, {
			"mcp-protocol-version": version,
		});
	}
	const name = method === "tools/call" ? params?.name : undefined;
	return mcpPost(
		{
			jsonrpc: "2.0",
			id,
			method,
			params: {
				...params,
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: version,
					[CLIENT_INFO_META_KEY]: CLIENT_INFO,
					[CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		},
		authorization,
		{
			"mcp-protocol-version": version,
			"mcp-method": method,
			...(typeof name === "string" ? { "mcp-name": name } : {}),
		},
	);
}

/** The request a chat app opens with, answered with the server's instructions. */
export const mcpOpen = (version: McpVersion, authorization?: string) =>
	version === "2025-06-18"
		? mcpPost(INITIALIZE, authorization)
		: mcpRequest(version, authorization, "server/discover");

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies, read field by field
export type RpcBody = { result?: any };

// A JSON-RPC response from /mcp, whether it came as JSON or as one SSE event.
export async function rpc(res: Response): Promise<RpcBody> {
	const text = await res.text();
	if (!res.headers.get("content-type")?.startsWith("text/event-stream")) {
		return JSON.parse(text);
	}
	const data = text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("");
	return JSON.parse(data);
}
