import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Transaction } from "@libsql/client";
import type { Db } from "./index";

const MIGRATIONS_DIR = fileURLToPath(
	new URL("../../migrations/", import.meta.url),
);

/** An applied migration's file no longer matches what was applied. */
class MigrationChanged extends Error {
	override name = "MigrationChanged";

	constructor(file: string) {
		super(
			`${file} changed after it was applied; put the change in a new numbered file`,
		);
	}
}

/** An applied migration's file was deleted. */
class MigrationMissing extends Error {
	override name = "MigrationMissing";

	constructor(files: string[]) {
		super(
			`${files.join(", ")} was applied but its file is gone; restore it, as applied migration files are never deleted`,
		);
	}
}

// Applied files deliberately deleted, with the sha256 they were applied at; a
// row for one of these needs no file. Only grows: any database may still hold
// the row.
// 0003_used_client.sql: used_client marked clients the sweep kept; clients are
// no longer swept, so nothing reads or writes it. Databases that applied it
// keep the table as it was.
const RETIRED: ReadonlyMap<string, string> = new Map([
	[
		"0003_used_client.sql",
		"fb93e2a8a670be5377453c9f135627875bd2f1b76b1d052dedda6dd9a7c4cd99",
	],
]);

type Migration = { name: string; sql: string; sha256: string };

const SCHEMA_MIGRATION_COLUMNS =
	"(name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT";

// Applies every *.sql in `dir` not yet recorded, in filename order, one write
// transaction per file. Returns the names it applied.
export async function migrate(
	db: Db,
	dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
	await db.execute(
		`CREATE TABLE IF NOT EXISTS schema_migration ${SCHEMA_MIGRATION_COLUMNS}`,
	);
	const files = await readMigrations(dir);
	if (!(await hasSha256Column(db))) await addHashes(db, files);
	const { rows } = await db.execute(
		"SELECT name, sha256 FROM schema_migration",
	);
	const appliedHashes = new Map(
		rows.map((row) => [String(row.name), String(row.sha256)]),
	);
	const fileNames = new Set(files.map((f) => f.name));
	const missing = [...appliedHashes]
		.filter(
			([name, hash]) => !fileNames.has(name) && RETIRED.get(name) !== hash,
		)
		.map(([name]) => name);
	if (missing.length > 0) throw new MigrationMissing(missing);
	for (const file of files) {
		const appliedHash = appliedHashes.get(file.name);
		if (appliedHash !== undefined && appliedHash !== file.sha256) {
			throw new MigrationChanged(file.name);
		}
	}
	const applied: string[] = [];
	for (const file of files.filter((f) => !appliedHashes.has(f.name))) {
		if (await applyOnce(db, file)) applied.push(file.name);
	}
	return applied;
}

async function readMigrations(dir: string): Promise<Migration[]> {
	const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
	return Promise.all(
		names.map(async (name) => {
			const sql = await readFile(join(dir, name), "utf8");
			const sha256 = createHash("sha256").update(sql).digest("hex");
			return { name, sql, sha256 };
		}),
	);
}

async function hasSha256Column(db: Db | Transaction): Promise<boolean> {
	const { rows } = await db.execute(
		"SELECT 1 FROM pragma_table_info('schema_migration') WHERE name = 'sha256'",
	);
	return rows.length > 0;
}

// Rebuilds a schema_migration written before hashes were recorded, giving each
// row its file's current hash (the files' content has not changed since, bar
// 0001's comment header) or its retired hash. Rebuilt, not ALTERed: SQLite
// adds a NOT NULL column only with a default, and the table would then differ
// from a fresh one.
async function addHashes(db: Db, files: Migration[]): Promise<void> {
	const fileHashes = new Map(files.map((f) => [f.name, f.sha256]));
	const tx = await db.transaction("write");
	try {
		// re-checked inside the write transaction: another run may have rebuilt it
		// since, and rebuilding again would overwrite the hashes it recorded
		if (await hasSha256Column(tx)) return;
		const { rows } = await tx.execute(
			"SELECT name, applied_at FROM schema_migration",
		);
		const missing = rows
			.map((row) => String(row.name))
			.filter((name) => !fileHashes.has(name) && !RETIRED.has(name));
		if (missing.length > 0) throw new MigrationMissing(missing);
		await tx.execute(
			`CREATE TABLE schema_migration_hashed ${SCHEMA_MIGRATION_COLUMNS}`,
		);
		for (const row of rows) {
			const name = String(row.name);
			await tx.execute({
				sql: "INSERT INTO schema_migration_hashed VALUES (?, ?, ?)",
				args: [
					name,
					fileHashes.get(name) ?? RETIRED.get(name) ?? null,
					Number(row.applied_at),
				],
			});
		}
		await tx.execute("DROP TABLE schema_migration");
		await tx.execute(
			"ALTER TABLE schema_migration_hashed RENAME TO schema_migration",
		);
		await tx.commit();
	} finally {
		if (!tx.closed) await tx.rollback();
	}
}

async function applyOnce(db: Db, file: Migration): Promise<boolean> {
	const tx = await db.transaction("write");
	try {
		// re-checked inside the write transaction: another run may have applied it since
		const seen = await tx.execute({
			sql: "SELECT sha256 FROM schema_migration WHERE name = ?",
			args: [file.name],
		});
		const row = seen.rows[0];
		if (row) {
			if (String(row.sha256) !== file.sha256) {
				throw new MigrationChanged(file.name);
			}
			return false;
		}
		await tx.executeMultiple(file.sql);
		await tx.execute({
			sql: "INSERT INTO schema_migration (name, sha256, applied_at) VALUES (?, ?, ?)",
			args: [file.name, file.sha256, Date.now()],
		});
		await tx.commit();
		return true;
	} finally {
		// awaited: over HTTP, close() is fire-and-forget and the next file's BEGIN could race it
		if (!tx.closed) await tx.rollback();
	}
}
