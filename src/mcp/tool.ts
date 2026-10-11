import type { CallToolResult } from "@modelcontextprotocol/server";
import { ConnectionKeyUnreadable } from "../db/index.ts";
import { errorClass } from "../log.ts";
import type { ToolScope } from "./server.ts";

/**
 * `run` as the callback of the tool named `tool`, each call's outcome logged. A throw becomes
 * a generic tool error: the SDK would hand its message to the chat.
 */
export function observed<Args extends unknown[]>(
  { log }: ToolScope,
  tool: string,
  run: (...args: Args) => Promise<CallToolResult>,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args) => {
    let result: CallToolResult;
    try {
      result = await run(...args);
    } catch (error) {
      log({
        event: "tool_call",
        tool,
        outcome: "error",
        ...errorClass(error instanceof Error ? error : new Error()),
      });
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "The tool failed on the server. Retry; if it keeps failing, tell the operator.",
          },
        ],
      };
    }
    log({
      event: "tool_call",
      tool,
      outcome: result.isError === true ? "tool_error" : "ok",
    });
    return result;
  };
}

/** The tool error for a caller with no usable connection: only a fresh connect flow can fix it. */
export function reconnectRequired(): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "This chat isn't connected to a Better Giving deployment. Reconnect Better Giving in your chat app's connector settings, then try again.",
      },
    ],
  };
}

/**
 * The caller's connection, or null when it has none it can use. A key that
 * won't open (sealed under another secret, for another row, or corrupted:
 * db/crypto.ts) is treated as lost: the connection and its connection-user are
 * dropped, so the chat app's tokens stop working and its next request starts
 * sign-in.
 */
export async function usableConnection(scope: ToolScope) {
  try {
    return await scope.connections.getByUserId(scope.userId);
  } catch (error) {
    if (!(error instanceof ConnectionKeyUnreadable)) throw error;
    await dropConnection(scope);
    return null;
  }
}

/** Drops the caller's connection and connection-user, so its chat app's tokens stop working. */
export async function dropConnection({
  connections,
  auth,
  userId,
}: ToolScope): Promise<void> {
  // the row first: a connection-user left behind gets the reconnect error, a row left behind never goes
  await connections.deleteByUserId(userId);
  await auth.deleteConnectionUser(userId);
}
