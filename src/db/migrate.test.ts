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

test("an applied migration whose file is gone is refused, naming it, before anything applies", async () => {
	await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE a (id TEXT);");
	await migrate(db, dir);
	await rm(join(dir, "0001_a.sql"));
	await writeFile(join(dir, "0002_b.sql"), "CREATE TABLE b (id TEXT);");

	await expect(migrate(db, dir)).rejects.toThrow(
		"0001_a.sql was applied but its file is gone",
	);
	const { rows } = await db.execute(
		"SELECT name FROM sqlite_schema WHERE name = 'b'",
	);
	expect(rows).toHaveLength(0);
});

// sha256 of 0003_used_client.sql as last shipped (`git show 5855b65^:migrations/0003_used_client.sql`)
const USED_CLIENT_SHA256 =
	"fb93e2a8a670be5377453c9f135627875bd2f1b76b1d052dedda6dd9a7c4cd99";

test("the retired 0003_used_client.sql is accepted without its file, and pending files still apply", async () => {
	await migrate(db, dir);
	await db.execute({
		sql: "INSERT INTO schema_migration VALUES ('0003_used_client.sql', ?, 0)",
		args: [USED_CLIENT_SHA256],
	});
	await writeFile(join(dir, "0004_b.sql"), "CREATE TABLE b (id TEXT);");

	expect(await migrate(db, dir)).toEqual(["0004_b.sql"]);
});

// what migrate before the sha256 column left behind, with 0001–0003 applied
async function legacyDb(names: string[]): Promise<void> {
	await db.execute(
		"CREATE TABLE schema_migration (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL) STRICT",
	);
	for (const name of names) {
		await db.execute({
			sql: "INSERT INTO schema_migration VALUES (?, 0)",
			args: [name],
		});
	}
}

test("a legacy table without hashes is upgraded, applying nothing, and stays quiet after", async () => {
	await legacyDb([
		"0001_better_auth.sql",
		"0002_connection.sql",
		"0003_used_client.sql",
	]);

	expect(await migrate(db)).toEqual([]);
	expect(await migrate(db)).toEqual([]);
	const { rows } = await db.execute(
		"SELECT name, sha256 FROM schema_migration WHERE name = '0003_used_client.sql'",
	);
	expect(rows[0]?.sha256).toBe(USED_CLIENT_SHA256);
});

test("a legacy table recording a file that is gone, and not retired, is refused, naming it", async () => {
	await legacyDb(["0001_better_auth.sql", "0002_gone.sql"]);

	await expect(migrate(db)).rejects.toThrow(
		"0002_gone.sql was applied but its file is gone",
	);
});
