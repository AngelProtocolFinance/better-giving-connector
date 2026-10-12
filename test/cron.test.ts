import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app";
import { cronRoutes } from "../src/cron";
import { createDb, type Db } from "../src/db";
import { migrate } from "../src/db/migrate";
import { type FakeDeployment, fakeDeployment } from "./fake-deployment";
import { BASE, env, warmUp } from "./harness";
import type { Call } from "./oauth";
import { connectFlow } from "./operator";

const DAY = 24 * 60 * 60 * 1000;

let db: Db;
let deployment: FakeDeployment;
let call: Call;

beforeEach(async () => {
	db = createDb({ url: ":memory:" });
	await migrate(db);
	deployment = fakeDeployment();
	const app = createApp({ env, db, fetch: deployment.fetch });
	call = async (req) => app.request(req);
	await warmUp(call);
	return () => db.close();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const BEARER = `Bearer ${env.CRON_SECRET}`;

const sweepRequest = (authorization?: string) =>
	new Request(`${BASE}/cron/sweep`, {
		headers: authorization ? { authorization } : {},
	});

// Users two days old with no token: each one a connection sweep drops.
async function seedDeadUsers(count: number) {
	const longAgo = new Date(Date.now() - 2 * DAY).toISOString();
	await db.execute({
		sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
			SELECT 'u' || i, 'n', i || '@connection.invalid', 0, ?1, ?1 FROM n`,
		args: [longAgo, count],
	});
}

async function countUsers() {
	const { rows } = await db.execute('SELECT count(*) AS n FROM "user"');
	return Number(rows[0]?.n);
}

test.each([
	["no Authorization header", undefined],
	["a wrong secret", "Bearer test-cron-secret-bbbbbbbbbbbbbbbbbbbbbbb"],
	["the secret without the Bearer scheme", env.CRON_SECRET],
	["a malformed header", "Bearer not a token!"],
])(
	"/cron/sweep with %s is 401 and sweeps nothing",
	async (_, authorization) => {
		await seedDeadUsers(1);

		const res = await call(sweepRequest(authorization));

		expect(res.status).toBe(401);
		expect(await res.text()).toBe("");
		expect(await countUsers()).toBe(1);
	},
);

async function countConnections() {
	const { rows } = await db.execute("SELECT count(*) AS n FROM connection");
	return Number(rows[0]?.n);
}

test("/cron/sweep with the secret drops a connection whose refresh token expired", async () => {
	await connectFlow(call, deployment, BASE).connect();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + 91 * DAY);

	const res = await call(sweepRequest(BEARER));

	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ connections: 1 });
	expect(await countConnections()).toBe(0);
});

test("/cron/sweep sweeps again while a batch comes back full", async () => {
	await seedDeadUsers(1001);

	const res = await call(sweepRequest(BEARER));

	expect(await res.json()).toEqual({ connections: 1001 });
	expect(await countUsers()).toBe(0);
});

test("/cron/sweep stops repeating once 50 s have passed, leaving the rest for tomorrow", async () => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	let now = 0;
	const cron = cronRoutes({
		auth: {
			// each batch is full and takes 30 s
			sweep: async () => {
				now += 30_000;
				return { connections: 500, more: true };
			},
		},
		secret: env.CRON_SECRET,
		clock: () => now,
	});

	const res = await cron.request(
		new Request(`${BASE}/sweep`, { headers: { authorization: BEARER } }),
	);

	expect(await res.json()).toEqual({ connections: 1000 });
});

test("/cron/sweep writes one log line, its counts and duration only", async () => {
	await seedDeadUsers(2);
	const out = vi.spyOn(console, "log").mockImplementation(() => {});
	const err = vi.spyOn(console, "error").mockImplementation(() => {});

	await call(sweepRequest(BEARER));

	const lines = [...out.mock.calls, ...err.mock.calls].map(([line]) => line);
	expect(lines).toHaveLength(1);
	expect(JSON.parse(lines[0])).toStrictEqual({
		kind: "sweep",
		connections: 2,
		ms: expect.any(Number),
	});
});

test("/cron/sweep that throws is a 500 logged by error name only", async () => {
	const err = vi.spyOn(console, "error").mockImplementation(() => {});
	const out = vi.spyOn(console, "log").mockImplementation(() => {});
	db.close();

	const res = await call(sweepRequest(BEARER));

	expect(res.status).toBe(500);
	expect(await res.json()).toEqual({ error: "internal_error" });
	expect(out).not.toHaveBeenCalled();
	expect(err.mock.calls).toEqual([
		[
			expect.stringMatching(
				/^\{"kind":"error","where":"app","errorName":"\w+"\}$/,
			),
		],
	]);
});
