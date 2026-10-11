import type {
  CallToolResult,
  McpServer,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { ActionAnswer, ActionRequest } from "../deployment/index.ts";
import type { ToolScope } from "./server.ts";
import {
  dropConnection,
  observed,
  reconnectRequired,
  usableConnection,
} from "./tool.ts";

/** A tool that forwards one `/connector/v1` action to the caller's deployment. */
export interface ForwardingTool<Input extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  /** the hello `revision` that carries the action (docs/connector-v1.md → Handshake) */
  revision: number;
  annotations: ToolAnnotations;
  input: Input;
  request(args: z.output<Input>): ActionRequest;
  /** the one line the chat reads beside the deployment's answer; `body` is null on a 204 */
  summary(body: Record<string, unknown> | null): string;
}

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** The tool result for a deployment's `answer`, per docs/connector-v1.md → Codes the connector acts on. */
async function resultOf(
  scope: ToolScope,
  answer: ActionAnswer,
  summary: (body: Record<string, unknown> | null) => string,
): Promise<CallToolResult> {
  switch (answer.outcome) {
    case "ok":
      return {
        content: [{ type: "text", text: summary(answer.body) }],
        structuredContent: answer.body,
      };
    case "done":
      return { content: [{ type: "text", text: summary(null) }] };
    case "key_refused":
      await dropConnection(scope);
      return reconnectRequired();
    case "unknown_route":
      return toolError(
        "Your Better Giving needs an update before the chat can do this. Update Better Giving, then try again.",
      );
    case "stale":
      return toolError(
        "This page changed since the chat last read it. Read it again, then make the change.",
      );
    case "rate_limited":
      return toolError(
        `Better Giving is getting too many requests from the chat. Wait ${
          answer.retryAfterSeconds === null
            ? "a minute"
            : `${answer.retryAfterSeconds} seconds`
        }, then try again.`,
      );
    case "refused":
      return toolError(`${answer.message} ${answer.fix}`);
    case "no_answer":
      return toolError("Better Giving didn't answer. Try again in a minute.");
  }
}

/** Registers `tool` on `server`: the caller's connection, the action sent with its key, the answer mapped. */
export function forwarding<Input extends z.ZodObject>(
  tool: ForwardingTool<Input>,
): (server: McpServer, scope: ToolScope) => void {
  const input: z.ZodObject = tool.input;
  return (server, scope) => {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: input,
        annotations: tool.annotations,
      },
      observed(scope, tool.name, async (args: z.output<typeof input>) => {
        const connection = await usableConnection(scope);
        if (connection === null) return reconnectRequired();
        const answer = await scope.deployments.act(
          connection.deploymentUrl,
          connection.key,
          // the SDK hands over `args` only once `tool.input` parsed them
          tool.request(args as z.output<Input>),
        );
        return resultOf(scope, answer, tool.summary);
      }),
    );
  };
}
