import { Hono } from "hono";
import { timingSafeEqual } from "hono/utils/buffer";
import type { AuthFacade } from "./auth";
import { log } from "./log";

// AuthFacade.sweep's per-call cap (src/auth/index.ts): a count this high may leave more.
const SWEEP_BATCH = 500;

// Under the function's maxDuration, with time left to answer.
const SWEEP_BUDGET_MS = 50_000;

const isFull = (swept: { connections: number; clients: number }) =>
	swept.connections === SWEEP_BATCH || swept.clients === SWEEP_BATCH;

export type CronDeps = { auth: AuthFacade; secret: string };

/** The jobs Vercel's cron calls, each with `Authorization: Bearer <CRON_SECRET>`. */
export function cronRoutes(deps: CronDeps): Hono {
	const expected = `Bearer ${deps.secret}`;
	const app = new Hono();
	// Not hono/bearer-auth: it answers a malformed header 400 and carries a body.
	app.use(async (c, next) => {
		const given = c.req.header("authorization") ?? "";
		if (!(await timingSafeEqual(expected, given))) return c.body(null, 401);
		await next();
	});
	app.get("/sweep", async (c) => {
		const started = performance.now();
		const totals = { connections: 0, clients: 0 };
		let batch: typeof totals;
		do {
			batch = await deps.auth.sweep();
			totals.connections += batch.connections;
			totals.clients += batch.clients;
		} while (isFull(batch) && performance.now() - started < SWEEP_BUDGET_MS);
		const ms = Math.round(performance.now() - started);
		log({ kind: "sweep", ...totals, ms });
		return c.json(totals, 200);
	});
	return app;
}
