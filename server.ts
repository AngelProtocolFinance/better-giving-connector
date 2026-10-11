import { createApp } from "./src/app.ts";
import { createDb } from "./src/db/index.ts";
import { appDeps } from "./src/deps.ts";
import { parseEnv } from "./src/env.ts";
import { consoleSink, createLogger } from "./src/log.ts";

// a deployment missing a var fails on load, its log naming the var, rather than mid sign-in
const env = parseEnv(process.env);
// migrated as a deploy step (`pnpm db:migrate`), never at boot
const db = createDb({
  url: env.TURSO_DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
});

/** The deployed app; `build.ts` bundles this file for Vercel. */
export default createApp(appDeps(env, db, createLogger(consoleSink)));
