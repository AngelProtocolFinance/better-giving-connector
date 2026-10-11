import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDb, migrate } from "./index.ts";

let db: Client;

beforeEach(() => {
  db = createDb({ url: ":memory:" });
});

afterEach(() => {
  db.close();
});

describe("migrate", () => {
  test("applies every migration to a fresh database", async () => {
    expect(await migrate(db)).toEqual([
      "0001_connection.sql",
      "0002_better_auth.sql",
      "0003_pending_connect.sql",
    ]);
    const tables = await db.execute(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'connection'",
    );
    expect(tables.rows).toHaveLength(1);
  });

  test("a second run applies nothing and keeps the rows", async () => {
    await migrate(db);
    await db.execute(
      "INSERT INTO connection (id, user_id, deployment_url, deployment_release, key_ciphertext) VALUES ('c1', 'user-1', 'https://give.example.org', '1.4.0', x'01')",
    );

    expect(await migrate(db)).toEqual([]);
    const rows = await db.execute("SELECT id FROM connection");
    expect(rows.rows.map((r) => r.id)).toEqual(["c1"]);
  });
});
