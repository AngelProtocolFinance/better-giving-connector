// Applies migrations/ to the database TURSO_DATABASE_URL names, with
// TURSO_AUTH_TOKEN when it is remote.
import { createDb } from "./client.ts";
import { migrate } from "./migrate.ts";

const url = process.env.TURSO_DATABASE_URL;
if (!url) throw new Error("TURSO_DATABASE_URL is not set");
const db = createDb({ url, authToken: process.env.TURSO_AUTH_TOKEN });
try {
  const applied = await migrate(db);
  for (const file of applied) console.log(`applied ${file}`);
  if (applied.length === 0) console.log("database is current");
} finally {
  db.close();
}
