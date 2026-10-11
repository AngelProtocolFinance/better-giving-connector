import type { Client } from "@libsql/client";
import type { AppDeps } from "./app.ts";
import { createConnectorAuth } from "./auth/index.ts";
import { attemptBinding } from "./connect/binding.ts";
import { connectionStore, pendingConnects } from "./db/index.ts";
import {
  type DeploymentNetwork,
  deploymentClient,
} from "./deployment/index.ts";
import type { Env } from "./env.ts";
import type { Log } from "./log.ts";

/**
 * What `createApp` needs, built once per process from the parsed env and its database; deployments
 * are reached over `network`.
 */
export function appDeps(
  env: Env,
  db: Client,
  log: Log,
  network: DeploymentNetwork,
): AppDeps {
  return {
    log,
    publicUrl: env.PUBLIC_URL,
    auth: createConnectorAuth({
      db,
      publicUrl: env.PUBLIC_URL,
      secret: env.BETTER_AUTH_SECRET,
    }),
    connections: connectionStore(db, env.CONNECTION_KEY_SECRET),
    pendingConnects: pendingConnects(db),
    attempts: attemptBinding(env.BETTER_AUTH_SECRET),
    deployments: deploymentClient(network),
  };
}
