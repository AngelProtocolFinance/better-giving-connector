import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDb, migrate, pendingConnects } from "./index.ts";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const IN_TEN_MINUTES = new Date("2026-10-11T12:10:00.000Z");

let db: Client;

beforeEach(async () => {
  db = createDb({ url: ":memory:" });
  await migrate(db);
});

afterEach(() => {
  db.close();
});

const attempt = {
  state: "c3RhdGUtMzItcmFuZG9tLWJ5dGVzLWJhc2U2NHVybA",
  oauthQuery: "response_type=code&client_id=abc&sig=xyz",
  codeVerifier: "dmVyaWZpZXItNDMtdG8tMTI4LWNoYXJhY3RlcnMtbG9uZw",
  deploymentUrl: "https://give.example.org",
  release: "1.4.0",
  expiresAt: IN_TEN_MINUTES,
};

describe("pendingConnects", () => {
  test("consume returns the attempt once, then null", async () => {
    const store = pendingConnects(db);
    await store.create(attempt);

    expect(await store.consume(attempt.state, NOW)).toStrictEqual({
      oauthQuery: "response_type=code&client_id=abc&sig=xyz",
      codeVerifier: "dmVyaWZpZXItNDMtdG8tMTI4LWNoYXJhY3RlcnMtbG9uZw",
      deploymentUrl: "https://give.example.org",
      release: "1.4.0",
      expired: false,
    });
    expect(await store.consume(attempt.state, NOW)).toBeNull();
  });

  test("of two concurrent consumes of one state, exactly one gets the attempt", async () => {
    // two clients on one file, as two function instances would reach one database
    const dir = await mkdtemp(join(tmpdir(), "pending-connect-"));
    const url = `file:${join(dir, "race.db")}`;
    const first = createDb({ url });
    const second = createDb({ url });
    try {
      await migrate(first);
      await pendingConnects(first).create(attempt);

      const results = await Promise.all([
        pendingConnects(first).consume(attempt.state, NOW),
        pendingConnects(second).consume(attempt.state, NOW),
      ]);

      expect(results.filter((r) => r !== null)).toHaveLength(1);
    } finally {
      first.close();
      second.close();
      await rm(dir, { recursive: true });
    }
  });

  test("consume after expiry returns the attempt marked expired, once", async () => {
    const store = pendingConnects(db);
    await store.create(attempt);

    expect(await store.consume(attempt.state, IN_TEN_MINUTES)).toStrictEqual({
      oauthQuery: "response_type=code&client_id=abc&sig=xyz",
      codeVerifier: "dmVyaWZpZXItNDMtdG8tMTI4LWNoYXJhY3RlcnMtbG9uZw",
      deploymentUrl: "https://give.example.org",
      release: "1.4.0",
      expired: true,
    });
    expect(await store.consume(attempt.state, NOW)).toBeNull();
  });

  test("sweepExpired deletes only the attempts expired past the grace period", async () => {
    const store = pendingConnects(db);
    const ONE_HOUR = 60 * 60 * 1000;
    await store.create({
      ...attempt,
      state: "past-grace",
      expiresAt: new Date("2026-10-11T10:59:59.999Z"),
    });
    await store.create({
      ...attempt,
      state: "grace-ends-now",
      expiresAt: new Date("2026-10-11T11:00:00.000Z"),
    });
    await store.create({
      ...attempt,
      state: "within-grace",
      expiresAt: new Date("2026-10-11T11:00:00.001Z"),
    });

    expect(await store.sweepExpired(NOW, ONE_HOUR)).toBe(2);
    expect(await store.consume("within-grace", NOW)).toMatchObject({
      expired: true,
    });
  });

  test("peek returns a live attempt and leaves it to consume", async () => {
    const store = pendingConnects(db);
    await store.create(attempt);

    expect(await store.peek(attempt.state, NOW)).toStrictEqual({
      oauthQuery: "response_type=code&client_id=abc&sig=xyz",
      codeVerifier: "dmVyaWZpZXItNDMtdG8tMTI4LWNoYXJhY3RlcnMtbG9uZw",
      deploymentUrl: "https://give.example.org",
      release: "1.4.0",
    });
    expect(await store.consume(attempt.state, NOW)).toMatchObject({
      expired: false,
    });
  });

  test("peek returns null for an expired or unknown state", async () => {
    const store = pendingConnects(db);
    await store.create(attempt);

    expect(await store.peek(attempt.state, IN_TEN_MINUTES)).toBeNull();
    expect(await store.peek("unknown", NOW)).toBeNull();
  });

  test("keeps an empty release, the caller's stand-in for a null one", async () => {
    const store = pendingConnects(db);
    await store.create({ ...attempt, release: "" });

    expect(await store.consume(attempt.state, NOW)).toMatchObject({
      release: "",
    });
  });
});
