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

export const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "chat-app", version: "1.0.0" },
	},
};

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
