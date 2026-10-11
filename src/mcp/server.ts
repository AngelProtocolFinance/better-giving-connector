import { McpServer } from "@modelcontextprotocol/server";
import type { AppDeps } from "../app.ts";
import { connectionStatus } from "./connection-status.ts";

/** What a tool acts with: the app's deps, and the connection-user the `/mcp` guard let in. */
export interface ToolScope extends AppDeps {
  userId: string;
}

/** The tools, each registering itself on a request's server: one per `/connector/v1` action, plus `connection_status`. */
const TOOLS: ((server: McpServer, scope: ToolScope) => void)[] = [
  connectionStatus,
];

/** The MCP server for one request: stateless, so built per request with its caller in scope. */
export function connectorServer(scope: ToolScope): McpServer {
  const server = new McpServer(
    { name: "Better Giving", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  for (const register of TOOLS) register(server, scope);
  return server;
}
