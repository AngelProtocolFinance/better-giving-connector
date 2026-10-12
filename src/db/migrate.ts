import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

type Migration = { name: string; sql: string; sha256: string };

// Applies every *.sql in `dir` not yet recorded, in filename order, one write
// transaction per file. Returns the names it applied.
export async function migrate(
	db: Db,
	dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
	await db.execute(
		"CREATE TABLE IF NOT EXISTS schema_migration (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT",
	);
	const files = await readMigrations(dir);
	const { rows } = await db.execute(
		"SELECT name, sha256 FROM schema_migration",
	);
	const appliedHashes = new Map(
		rows.map((row) => [String(row.name), String(row.sha256)]),
	);
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
