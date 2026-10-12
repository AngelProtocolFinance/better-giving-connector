import { Hono, type MiddlewareHandler } from "hono";
import { timingSafeEqual } from "hono/utils/buffer";
import type { AppDeps } from "./app.ts";
import { SWEEP_GRACE_MS } from "./connect/flow.ts";
import { ConnectionKeyUnreadable } from "./db/index.ts";
import { DeploymentKey } from "./deployment/index.ts";
import { problem } from "./problem.ts";

/**
 * No batch starts past this: one started just before it can still spend `SWEEP_LIMIT` revokes at
 * the deployment client's per-call timeout each, and must end inside the function's maxDuration.
 */
const SWEEP_BUDGET_MS = 45_000;
const SWEEP_LIMIT = 25;

/** The deployment didn't take the revoke: the user is kept for the next sweep. */
class RevokeUnanswered extends Error {
  override name = "RevokeUnanswered";
}

/**
 * The jobs Vercel Cron calls, each with `Authorization: Bearer <CRON_SECRET>`.
 * Not hono/bearer-auth: it answers a malformed header 400, and not as a problem.
 */
export function cronRoutes(deps: AppDeps) {
  const expected = `Bearer ${deps.cronSecret}`;
  const fromVercelCron: MiddlewareHandler = async (c, next) => {
    const given = c.req.header("authorization") ?? "";
    if (!(await timingSafeEqual(expected, given))) {
      return problem(401, "unauthorized", "Only Vercel Cron calls this route.");
    }
    await next();
  };

  /** Revokes the user's deployment key, then drops its row; throws only when a retry may do better. */
  async function disconnect(userId: string): Promise<void> {
    let connection: Awaited<ReturnType<typeof deps.connections.getByUserId>>;
    try {
      connection = await deps.connections.getByUserId(userId);
    } catch (error) {
      if (!(error instanceof ConnectionKeyUnreadable)) throw error;
      // a key that won't open can't be revoked, by this run or the next
      await deps.connections.deleteByUserId(userId);
      return;
    }
    if (connection === null) return;
    const answer = await deps.deployments.act(
      connection.deploymentUrl,
      new DeploymentKey(connection.key),
      { method: "POST", path: "/disconnect" },
    );
    // any other answer is the deployment's last word on this key: a 401 means it's already refused
    if (answer.outcome === "no_answer" || answer.outcome === "rate_limited") {
      throw new RevokeUnanswered();
    }
    await deps.connections.deleteByUserId(userId);
  }

  return new Hono().use(fromVercelCron).get("/sweep", async (c) => {
    const started = performance.now();
    await deps.pendingConnects.sweepExpired(new Date(), SWEEP_GRACE_MS);
    let disconnected = 0;
    let clientsDeleted = 0;
    let more = true;
    // a user whose disconnect failed comes back in the next batch: count it once
    const failing = new Set<string>();
    while (more && performance.now() - started < SWEEP_BUDGET_MS) {
      const batch = await deps.auth.sweep({
        limit: SWEEP_LIMIT,
        disconnect: async (userId) => {
          try {
            await disconnect(userId);
          } catch (error) {
            failing.add(userId);
            throw error;
          }
          failing.delete(userId);
        },
      });
      disconnected += batch.disconnected;
      clientsDeleted += batch.clientsDeleted;
      more = batch.more;
    }
    const swept = { disconnected, failed: failing.size, clientsDeleted, more };
    deps.log({ event: "sweep", ...swept });
    return c.json(swept, 200);
  });
}
