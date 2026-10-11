import { readdir, readFile } from "node:fs/promises";
import type { Db } from "./index";

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);

// Applies every migrations/*.sql not yet recorded, in filename order, one
// write transaction per file. Returns the names it applied.
export async function migrate(db: Db): Promise<string[]> {
	await db.execute(
		"CREATE TABLE IF NOT EXISTS schema_migration (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL) STRICT",
	);
	const names = (await readdir(MIGRATIONS_DIR))
		.filter((name) => name.endsWith(".sql"))
		.sort();
	const applied: string[] = [];
	for (const name of names) {
		const sql = await readFile(new URL(name, MIGRATIONS_DIR), "utf8");
		if (await applyOnce(db, name, sql)) applied.push(name);
	}
	return applied;
}

async function applyOnce(db: Db, name: string, sql: string): Promise<boolean> {
	const tx = await db.transaction("write");
	try {
		// checked inside the write transaction so two concurrent runs can't both apply it
		const seen = await tx.execute({
			sql: "SELECT 1 FROM schema_migration WHERE name = ?",
			args: [name],
		});
		if (seen.rows.length > 0) return false;
		await tx.executeMultiple(sql);
		await tx.execute({
			sql: "INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)",
			args: [name, Date.now()],
		});
		await tx.commit();
		return true;
	} finally {
		tx.close();
	}
}
