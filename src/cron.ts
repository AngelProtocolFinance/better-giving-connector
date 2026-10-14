import { Hono } from "hono";
import { timingSafeEqual } from "hono/utils/buffer";
import type { AuthFacade } from "./auth";
import { log } from "./log";

// Under the function's maxDuration, with time left to answer.
const SWEEP_BUDGET_MS = 50_000;

export type CronDeps = {
	auth: Pick<AuthFacade, "sweep">;
	secret: string;
	/** Milliseconds from any fixed start; `performance.now` unless given. */
	clock?: () => number;
};

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
		const clock = deps.clock ?? (() => performance.now());
		const started = clock();
		let connections = 0;
		let more: boolean;
		do {
			const batch = await deps.auth.sweep();
			connections += batch.connections;
			more = batch.more;
		} while (more && clock() - started < SWEEP_BUDGET_MS);
		log({ kind: "sweep", connections, ms: Math.round(clock() - started) });
		return c.json({ connections }, 200);
	});
	return app;
}
