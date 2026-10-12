import { vi } from "vitest";
import { createDb, type Db } from "../src/db";
import { migrate } from "../src/db/migrate";

// A migrated in-memory database with foreign keys off. src/auth deletes a
// connection's rows one table at a time because foreign_keys is a
// per-connection libSQL setting, so a test that asserts a drop must not get
// the cascades for free (the embedded default has them on).
export async function freshDb(): Promise<Db> {
	const db = createDb({ url: ":memory:" });
	await db.execute("PRAGMA foreign_keys = OFF");
	await migrate(db);
	return db;
}

export class StoreDown extends Error {
	override name = "StoreDown";
}

/**
 * `db` seen through a proxy whose statements matching `failOn`'s pattern
 * reject with its error, until `heal`. Everything else reaches `db`.
 */
export function failingDb(db: Db) {
	let rule: { match: RegExp; error: Error } | null = null;
	const proxy: Db = new Proxy(db, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop !== "execute") return value.bind(target);
			return (stmt: string | { sql: string }, ...rest: unknown[]) => {
				const sql = typeof stmt === "string" ? stmt : stmt.sql;
				if (rule?.match.test(sql)) return Promise.reject(rule.error);
				return value.call(target, stmt, ...rest);
			};
		},
	});
	return {
		db: proxy,
		failOn(match: RegExp, error: Error) {
			rule = { match, error };
		},
		heal() {
			rule = null;
		},
	};
}

/**
 * Moves `Date` forward by `ms`, repeatedly if called again; the timers stay
 * real. The caller's `afterEach` restores them (`vi.useRealTimers()`).
 */
export function advance(ms: number) {
	if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + ms);
}

export const MINUTE = 60 * 1000;
export const DAY = 24 * 60 * MINUTE;

export async function countRows(db: Db, table: string): Promise<number> {
	const { rows } = await db.execute(`SELECT count(*) AS n FROM "${table}"`);
	return Number(rows[0]?.n);
}

const CONNECTION_TABLES = [
	"connection",
	"user",
	"session",
	"oauthAccessToken",
	"oauthRefreshToken",
	"oauthConsent",
] as const;

/** The rows a connection leaves in every table it touches, by table. */
export async function connectionRows(db: Db) {
	const counts = await Promise.all(
		CONNECTION_TABLES.map((t) => countRows(db, t)),
	);
	return Object.fromEntries(
		CONNECTION_TABLES.map((t, i) => [t, counts[i]]),
	) as Record<(typeof CONNECTION_TABLES)[number], number>;
}

/** What `connectionRows` reads while one connection is live, tokens issued. */
export const LIVE_CONNECTION_ROWS = Object.fromEntries(
	CONNECTION_TABLES.map((t) => [t, 1]),
) as Record<(typeof CONNECTION_TABLES)[number], number>;

/** What `connectionRows` reads once a connection is dropped. */
export const NO_CONNECTION_ROWS = Object.fromEntries(
	CONNECTION_TABLES.map((t) => [t, 0]),
) as Record<(typeof CONNECTION_TABLES)[number], number>;

/** Users two days old with no token: each one a sweep drops. */
export async function seedDeadUsers(db: Db, count: number) {
	const longAgo = new Date(Date.now() - 2 * DAY).toISOString();
	await db.execute({
		sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
			SELECT 'u' || i, 'n', i || '@connection.invalid', 0, ?1, ?1 FROM n`,
		args: [longAgo, count],
	});
}
