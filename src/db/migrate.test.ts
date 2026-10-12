import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

	expect(first).toContain("0002_connection.sql");
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
