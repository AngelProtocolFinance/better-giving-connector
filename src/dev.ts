import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createDb, migrate } from "./db/index.ts";
import { appDeps } from "./deps.ts";
import { isLocalDatabase, parseEnv } from "./env.ts";
import { consoleSink, createLogger } from "./log.ts";

const env = parseEnv(process.env);
const db = createDb({
  url: env.TURSO_DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
});
// a remote database is migrated only by `pnpm db:migrate`, as a deploy does
if (isLocalDatabase(env.TURSO_DATABASE_URL)) await migrate(db);

const app = createApp(appDeps(env, db, createLogger(consoleSink)));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) }, (info) => {
  console.log(`connector on http://localhost:${info.port}`);
});
