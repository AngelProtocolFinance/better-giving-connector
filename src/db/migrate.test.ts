import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDb, type Db } from "./index";
import { migrate } from "./migrate";

let db: Db;
let dir: string;

beforeEach(async () => {
	db = createDb({ url: ":memory:" });
	dir = await mkdtemp(join(tmpdir(), "migrations-"));
});

afterEach(async () => {
	db.close();
	await rm(dir, { recursive: true });
});

test("a second run applies nothing", async () => {
	const first = await migrate(db);
	const second = await migrate(db);

	const shipped = await readdir(new URL("../../migrations/", import.meta.url));
	expect(first).toEqual(shipped.filter((f) => f.endsWith(".sql")).toSorted());
	expect(first.length).toBeGreaterThan(0);
	expect(second).toEqual([]);
});

test("an applied migration whose file changed is refused, naming the file", async () => {
	await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE a (id TEXT);");
	await migrate(db, dir);
	await writeFile(
		join(dir, "0001_a.sql"),
		"CREATE TABLE a (id TEXT);\nCREATE TABLE b (id TEXT);",
	);

	await expect(migrate(db, dir)).rejects.toThrow("0001_a.sql");
	const { rows } = await db.execute(
		"SELECT name FROM sqlite_schema WHERE name = 'b'",
	);
	expect(rows).toHaveLength(0);
});

test("a file whose second statement fails leaves nothing behind", async () => {
	await writeFile(
		join(dir, "0001_a.sql"),
		"CREATE TABLE a (id TEXT);\nINSERT INTO missing VALUES (1);",
	);

	await expect(migrate(db, dir)).rejects.toThrow();

	const { rows } = await db.execute(
		"SELECT name FROM sqlite_schema WHERE name = 'a'",
	);
	expect(rows).toHaveLength(0);
	const recorded = await db.execute("SELECT name FROM schema_migration");
	expect(recorded.rows).toHaveLength(0);
});

// `db` where `race` runs right after migrate lists what was applied, as another
// run landing before this one's write transaction would.
function racing(race: () => Promise<unknown>): Db {
	return new Proxy(db, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop !== "execute") return value.bind(target);
			return async (stmt: string, ...rest: unknown[]) => {
				const result = await value.call(target, stmt, ...rest);
				if (stmt.startsWith("SELECT name, sha256 FROM schema_migration")) {
					await race();
				}
				return result;
			};
		},
	});
}

test("a file another run applied after this one listed what was applied is skipped, not applied twice", async () => {
	await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE a (id TEXT);");

	const applied = await migrate(
		racing(() => migrate(db, dir)),
		dir,
	);

	expect(applied).toEqual([]);
	const recorded = await db.execute("SELECT name FROM schema_migration");
	expect(recorded.rows.map((r) => r.name)).toEqual(["0001_a.sql"]);
});

test("a file another run applied with different contents is refused, naming the file", async () => {
	await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE a (id TEXT);");
	const racer = racing(() =>
		db.execute(
			"INSERT INTO schema_migration VALUES ('0001_a.sql', 'another-hash', 0)",
		),
	);

	await expect(migrate(racer, dir)).rejects.toThrow("0001_a.sql");
});
