import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes, routePath } from "hono/route";
import { errorClass, type Log } from "./log.ts";
import { problem } from "./problem.ts";

/** Everything the app reads that isn't in a request. */
export interface AppDeps {
  log: Log;
}

export function createApp(deps: AppDeps) {
  const logRequest: MiddlewareHandler = async (c, next) => {
    const start = performance.now();
    await next();
    // after next(), routeIndex is the last handler that ran: this one when no route matched
    const responder = matchedRoutes(c)[c.req.routeIndex];
    deps.log({
      event: "request",
      method: c.req.method,
      route:
        responder?.handler === logRequest ? null : (responder?.path ?? null),
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
    });
  };

  const app = new Hono();
  // first, so every route below it is logged
  app.use(logRequest);
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

  return app.get("/health", (c) => c.json({ ok: true }, 200));
}

/** The routes and the bodies and statuses each returns, for a typed client. */
export type AppType = ReturnType<typeof createApp>;
