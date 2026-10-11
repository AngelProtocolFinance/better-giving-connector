import { type Context, Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { methodNotAllowed } from "hono/method-not-allowed";
import { matchedRoutes, routePath } from "hono/route";
import { AUTH_BASE_PATH, type ConnectorAuth, MCP_PATH } from "./auth/index.ts";
import type { connectionStore } from "./db/index.ts";
import { errorClass, type Log } from "./log.ts";
import { mcpHandlers } from "./mcp/route.ts";
import { problem } from "./problem.ts";

/** Everything the app reads that isn't in a request. */
export interface AppDeps {
  log: Log;
  /** one per process: it caches the signing keys */
  auth: ConnectorAuth;
  connections: ReturnType<typeof connectionStore>;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  const answerMethodNotAllowed = methodNotAllowed({
    app,
    // `methods` adds HEAD to every GET path, served from the GET handler unasked
    onMethodNotAllowed: (_, methods) =>
      problem(
        405,
        "method_not_allowed",
        `Use ${methods.filter((method) => method !== "HEAD").join(" or ")}.`,
        { allow: methods.join(", ") },
      ),
  });

  const logRequest: MiddlewareHandler = async (c, next) => {
    const start = performance.now();
    await next();
    // after next(), routeIndex is the last handler that ran: an app-wide middleware when no route matched
    const responder = matchedRoutes(c)[c.req.routeIndex];
    deps.log({
      event: "request",
      method: c.req.method,
      route:
        responder === undefined || appWide.has(responder.handler)
          ? null
          : responder.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
    });
  };

  const appWide = new Set([logRequest, answerMethodNotAllowed]);
  // first, so every route below it is logged
  app.use(logRequest);
  app.use(answerMethodNotAllowed);
  app.notFound((c) =>
    problem(404, "route_not_found", `No route for ${c.req.path}.`),
  );
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    deps.log({
      event: "unhandled_error",
      method: c.req.method,
      route: routePath(c),
      ...errorClass(error),
    });
    return problem(
      500,
      "internal_error",
      "The request failed on the server. Retry; if it keeps failing, tell the operator.",
    );
  });

  const signIn = (c: Context) => deps.auth.handler(c.req.raw);
  return (
    app
      .get("/health", (c) => c.json({ ok: true }, 200))
      .on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, signIn)
      // a GET route answers HEAD too
      .get("/.well-known/oauth-authorization-server", signIn)
      .get("/.well-known/oauth-protected-resource", signIn)
      .get(`/.well-known/oauth-protected-resource${MCP_PATH}`, signIn)
      .post(MCP_PATH, ...mcpHandlers(deps))
  );
}

/** The routes and the bodies and statuses each returns, for a typed client. */
export type AppType = ReturnType<typeof createApp>;
