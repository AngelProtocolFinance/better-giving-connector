import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AuthFacade, createAuth } from "./auth";
import { connections as connectionStore, type Db } from "./db";
import { deploymentClient } from "./deployment";
import type { Env } from "./env";
import { log } from "./log";
import { mcpRoute } from "./mcp";

export type AppDeps = { env: Env; db: Db; fetch: typeof fetch };

export function createApp(deps: AppDeps): Hono {
	return composeApp(deps).app;
}

/**
 * The app with the auth facade it was built around. Tests drive
 * `auth.completeConnection` through it in place of the connect flow.
 */
export function composeApp(deps: AppDeps): { app: Hono; auth: AuthFacade } {
	const connections = connectionStore(deps.db, deps.env.CONNECTION_KEY_SECRET);
	const auth = createAuth({ db: deps.db, connections, env: deps.env });

	const app = new Hono();
	const toAuth = (c: { req: { raw: Request } }) => auth.handler(c.req.raw);
	app.on(["GET", "POST"], "/api/auth/*", toAuth);
	app.get("/.well-known/oauth-authorization-server/api/auth", toAuth);
	app.get("/.well-known/oauth-protected-resource", toAuth);
	app.get("/.well-known/oauth-protected-resource/mcp", toAuth);
	app.route(
		"/mcp",
		mcpRoute({
			auth,
			connections,
			client: deploymentClient({ fetch: deps.fetch }),
			resource: new URL("/mcp", deps.env.PUBLIC_URL),
		}),
	);
	// The error's name only: a message can carry a key, a tool argument or SQL.
	app.onError((err, c) => {
		if (err instanceof HTTPException) return err.getResponse();
		log({ kind: "error", where: "app", errorName: err.name });
		return c.json({ error: "internal_error" }, 500);
	});
	return { app, auth };
}
