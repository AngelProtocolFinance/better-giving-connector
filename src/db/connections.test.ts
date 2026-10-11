import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ConnectionExists,
  ConnectionKeyUnreadable,
  connectionStore,
  createDb,
  migrate,
} from "./index.ts";

const SECRET = Buffer.alloc(32, 7).toString("base64");
const OTHER_SECRET = Buffer.alloc(32, 8).toString("base64");
const KEY = "bg_live_k3y-material-1234567890";

let db: Client;

beforeEach(async () => {
  db = createDb({ url: ":memory:" });
  await migrate(db);
});

afterEach(() => {
  db.close();
});

const connection = {
  userId: "user-1",
  deploymentUrl: "https://give.example.org",
  release: "1.4.0",
  key: KEY,
};

describe("connectionStore", () => {
  test("round-trips a connection's key, stored encrypted", async () => {
    const store = connectionStore(db, SECRET);
    const { id } = await store.create(connection);

    expect(await store.getByUserId("user-1")).toStrictEqual({
      id,
      deploymentUrl: "https://give.example.org",
      release: "1.4.0",
      key: KEY,
    });
    const raw = await db.execute("SELECT key_ciphertext FROM connection");
    const stored = raw.rows[0]?.key_ciphertext;
    expect(stored).toBeInstanceOf(ArrayBuffer);
    expect(Buffer.from(stored as ArrayBuffer).toString("latin1")).not.toContain(
      KEY,
    );
  });

  test("refuses to read a key sealed under another secret", async () => {
    await connectionStore(db, SECRET).create(connection);

    await expect(
      connectionStore(db, OTHER_SECRET).getByUserId("user-1"),
    ).rejects.toThrow(ConnectionKeyUnreadable);
  });

  test("refuses a sealed key copied onto another connection", async () => {
    const store = connectionStore(db, SECRET);
    await store.create(connection);
    await store.create({ ...connection, userId: "user-2", key: "other-key" });

    await db.execute(
      "UPDATE connection SET key_ciphertext = (SELECT key_ciphertext FROM connection WHERE user_id = 'user-1') WHERE user_id = 'user-2'",
    );

    await expect(store.getByUserId("user-2")).rejects.toThrow(
      ConnectionKeyUnreadable,
    );
  });

  test("refuses a second connection for the same user", async () => {
    const store = connectionStore(db, SECRET);
    const { id } = await store.create(connection);

    await expect(
      store.create({ ...connection, key: "replacement-key" }),
    ).rejects.toThrow(ConnectionExists);
    expect(await store.getByUserId("user-1")).toMatchObject({ id, key: KEY });
  });

  test("deleteByUserId removes only that user's connection", async () => {
    const store = connectionStore(db, SECRET);
    await store.create(connection);
    await store.create({ ...connection, userId: "user-2" });

    await store.deleteByUserId("user-1");

    expect(await store.getByUserId("user-1")).toBeNull();
    expect(await store.getByUserId("user-2")).toMatchObject({ key: KEY });
  });

  test("deleteById removes only that connection", async () => {
    const store = connectionStore(db, SECRET);
    const { id } = await store.create(connection);
    await store.create({ ...connection, userId: "user-2" });

    await store.deleteById(id);

    expect(await store.getByUserId("user-1")).toBeNull();
    expect(await store.getByUserId("user-2")).toMatchObject({ key: KEY });
  });

  test("a corrupted key fails with an error that carries no key material", async () => {
    const store = connectionStore(db, SECRET);
    await store.create(connection);
    const raw = await db.execute("SELECT key_ciphertext FROM connection");
    const sealed = new Uint8Array(raw.rows[0]?.key_ciphertext as ArrayBuffer);
    sealed[sealed.length - 1] = (sealed.at(-1) ?? 0) ^ 0xff;
    await db.execute({
      sql: "UPDATE connection SET key_ciphertext = ?",
      args: [sealed],
    });

    const error = await store.getByUserId("user-1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectionKeyUnreadable);
    const { message, stack, cause } = error as Error;
    expect(`${message}\n${stack}`).not.toContain(KEY);
    expect(`${message}\n${stack}`).not.toContain(SECRET);
    expect(cause).toBeUndefined();
  });

  test("refuses a secret that isn't 32 base64-encoded bytes, without echoing it", () => {
    const short = Buffer.alloc(16, 7).toString("base64");

    expect(() => connectionStore(db, short)).toThrow(
      "CONNECTION_KEY_SECRET must be 32 random bytes, base64-encoded",
    );
    expect(() => connectionStore(db, short)).not.toThrow(short);
  });
});
