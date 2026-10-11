import {
  createMcpHandler,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { bodyLimit } from "hono/body-limit";
import { createFactory } from "hono/factory";
import type { AppDeps } from "../app.ts";
import { problem } from "../problem.ts";
import { connectorServer } from "./server.ts";

/** Room for the largest tool argument a `/connector/v1` action takes: a whole page `document` (docs/connector-v1.md). */
const MAX_BODY_BYTES = 512 * 1024;

type JsonRpcRequest = { method: string; id?: string | number | null };

function isListenRequest(message: unknown): message is JsonRpcRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    message.method === "subscriptions/listen"
  );
}

/** A `subscriptions/listen` among a POST's messages; malformed JSON is left for the SDK to answer. */
function listenRequestIn(body: string): JsonRpcRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).find(isListenRequest);
}

/**
 * The tools never change, so a listen stream would only hold a function open.
 * Refused, not capped: `maxSubscriptions` counts per handler, and one is built
 * per request.
 */
function refuseListen(id: string | number | null): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message:
        "subscriptions/listen is not offered: these tools never change, so there is nothing to notify.",
    },
  });
}

type McpEnv = { Variables: { userId: string } };

/** `POST /mcp`: stateless streamable HTTP, behind the bearer-token guard. */
export function mcpHandlers(deps: AppDeps) {
  const factory = createFactory<McpEnv>();
  return factory.createHandlers(
    // the MCP transport spec: servers MUST validate Origin; only a page served from this host may call it from a browser
    factory.createMiddleware(async (c, next) => {
      const crossOrigin = originValidationResponse(c.req.raw, [
        new URL(c.req.url).hostname,
      ]);
      if (crossOrigin !== undefined) return crossOrigin;
      await next();
    }),
    factory.createMiddleware(async (c, next) => {
      const access = await deps.auth.verifyMcpRequest(c.req.raw);
      if (!access.ok) {
        return problem(
          401,
          "unauthenticated",
          "Send a bearer token from this server's OAuth sign-in.",
          { "www-authenticate": access.wwwAuthenticate },
        );
      }
      c.set("userId", access.userId);
      await next();
    }),
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () =>
        problem(
          413,
          "body_too_large",
          `An MCP request body is at most ${MAX_BODY_BYTES} bytes.`,
        ),
    }),
    async (c) => {
      // read here, where bodyLimit can refuse it; the SDK gets it back in a request of its own
      const body = await c.req.text();
      const listen = listenRequestIn(body);
      if (listen !== undefined) return refuseListen(listen.id ?? null);
      const { raw } = c.req;
      const scope = { ...deps, userId: c.get("userId") };
      return createMcpHandler(() => connectorServer(scope)).fetch(
        new Request(raw.url, {
          method: raw.method,
          headers: raw.headers,
          body,
          signal: raw.signal,
        }),
      );
    },
  );
}
