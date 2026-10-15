import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createAuth } from "./auth";
import { connectRoutes } from "./connect";
import { cronRoutes } from "./cron";
import { connections as connectionStore, type Db } from "./db";
import { deploymentClient } from "./deployment";
import type { Env } from "./env";
import { log } from "./log";
import { mcpRoute } from "./mcp";
import { publicRoutes } from "./site";

export type AppDeps = { env: Env; db: Db; fetch: typeof fetch };

export function createApp(deps: AppDeps): Hono {
	const connections = connectionStore(deps.db, deps.env.CONNECTION_KEY_SECRET);
	const client = deploymentClient({ fetch: deps.fetch });
	const auth = createAuth({ db: deps.db, connections, env: deps.env, client });

	const app = new Hono();
	const toAuth = (c: { req: { raw: Request } }) => auth.handler(c.req.raw);
	app.on(["GET", "POST"], "/api/auth/*", toAuth);
	app.get("/.well-known/oauth-authorization-server/api/auth", toAuth);
	app.get("/.well-known/oauth-protected-resource", toAuth);
	app.get("/.well-known/oauth-protected-resource/mcp", toAuth);
	app.route("/", publicRoutes(deps.env.OPENAI_APPS_CHALLENGE));
	app.route(
		"/connect",
		connectRoutes({
			auth,
			client,
			// better-auth signs its own cookies with this secret in the same
			// `value.signature` form, so the state cookie gets a key of its own.
			stateSecret: createHmac("sha256", deps.env.BETTER_AUTH_SECRET)
				.update("connect state cookie")
				.digest("base64url"),
			publicUrl: deps.env.PUBLIC_URL,
		}),
	);
	app.route("/cron", cronRoutes({ auth, secret: deps.env.CRON_SECRET }));
	app.route(
		"/mcp",
		mcpRoute({
			auth,
			connections,
			client,
			resource: new URL("/mcp", deps.env.PUBLIC_URL),
		}),
	);
	// The error's name only: a message can carry a key, a tool argument or SQL.
	app.onError((err, c) => {
		if (err instanceof HTTPException) return err.getResponse();
		log({ kind: "error", where: "app", errorName: err.name });
		return c.json({ error: "internal_error" }, 500);
	});
	return app;
}
