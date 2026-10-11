import type { Client } from "@libsql/client";
import type { AppDeps } from "./app.ts";
import { createConnectorAuth } from "./auth/index.ts";
import { connectionStore } from "./db/index.ts";
import type { Env } from "./env.ts";
import type { Log } from "./log.ts";

/** What `createApp` needs, built once per process from the parsed env and its database. */
export function appDeps(env: Env, db: Client, log: Log): AppDeps {
  return {
    log,
    auth: createConnectorAuth({
      db,
      publicUrl: env.PUBLIC_URL,
      secret: env.BETTER_AUTH_SECRET,
    }),
    connections: connectionStore(db, env.CONNECTION_KEY_SECRET),
  };
}
