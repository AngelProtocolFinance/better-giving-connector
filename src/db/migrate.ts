import { readdir, readFile } from "node:fs/promises";
import type { Client } from "@libsql/client";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

const BOOKKEEPING_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT`;

/**
 * Applies each `.sql` file in `migrations/` not yet recorded in
 * `schema_migrations`, in file-name order, each in its own write transaction
 * with its record, so a failed file leaves nothing of itself behind and the
 * next run retries it. Returns the files applied; none on a current database.
 * Reads the files from disk beside the source, so it runs from `src/`, never
 * from a bundle.
 */
export async function migrate(db: Client): Promise<string[]> {
  await db.execute(BOOKKEEPING_DDL);
  const recorded = await db.execute("SELECT name FROM schema_migrations");
  const applied = new Set(recorded.rows.map((r) => String(r.name)));
  const pending = (await readdir(MIGRATIONS))
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .sort();
  for (const file of pending) {
    const sql = await readFile(new URL(file, MIGRATIONS), "utf8");
    const tx = await db.transaction("write");
    try {
      await tx.executeMultiple(sql);
      await tx.execute({
        sql: "INSERT INTO schema_migrations (name, applied_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
        args: [file],
      });
      await tx.commit();
    } finally {
      tx.close();
    }
  }
  return pending;
}
