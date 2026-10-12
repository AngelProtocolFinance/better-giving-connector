import { afterEach, describe, expect, test, vi } from "vitest";
import { connectionStore } from "./db/index.ts";
import {
  createFakeDeployment,
  type FakeDeployment,
} from "./fake-deployment/app.ts";
import {
  authorizeChatApp,
  CRON_SECRET,
  PUBLIC_URL,
  startApp,
  type TestApp,
} from "./test-app.ts";

const DEPLOYMENT = "https://give.hopeshelter.org";
/** past when no token from a connect whose code was never exchanged can be live */
const STALE_AFTER_MS = 76 * 60_000;

let t: TestApp;
let fake: FakeDeployment;
/** what the deployment answers in `fake`'s place; `fake` itself when unset */
let answer: (() => Response) | undefined;

afterEach(() => {
  answer = undefined;
  vi.useRealTimers();
  t.db.close();
});

/** The app with `fake` answering at every public host. */
async function startWithFake() {
  fake = createFakeDeployment({ returnTo: `${PUBLIC_URL}/connect/return` });
  t = await startApp({
    lookup: async () => "public",
    fetch: async (url, init) => answer?.() ?? fake.app.request(url, init),
  });
}

/** A connection whose chat app never redeemed its code, holding a key `fake` minted. */
async function connection() {
  const { connectQuery } = await authorizeChatApp(t);
  const { userId } = await t.auth.connectionSignIn(connectQuery);
  const key = fake.mintKey();
  await t.connections.create({
    userId,
    deploymentUrl: DEPLOYMENT,
    release: "1.4.0",
    key,
  });
  return { userId, key };
}

/** A chat app's registration that no connection completed through. */
async function registeredClient() {
  const res = await t.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "never connected",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBe(201);
}

/** past when a client no connection completed through is swept */
const UNUSED_CLIENT_AFTER_MS = 25 * 60 * 60_000;
/** one more than a batch's limit */
const TWO_BATCHES = 26;

/** The clock moved on by `ms`. */
function later(ms: number) {
  vi.useFakeTimers({ toFake: ["Date", "performance"], now: Date.now() + ms });
}

async function userIds(): Promise<string[]> {
  const users = await t.db.execute('SELECT id FROM "user"');
  return users.rows.map((row) => String(row.id));
}

/** The sweep as Vercel Cron calls it, with `authorization` as its header. */
function sweep(authorization = `Bearer ${CRON_SECRET}`) {
  return t.request("/cron/sweep", { headers: { authorization } });
}

describe("GET /cron/sweep", () => {
  test.each([
    ["no authorization", undefined],
    ["another secret", "Bearer not-the-cron-secret-0123456789abcdef"],
    ["the secret without its scheme", CRON_SECRET],
    ["the secret under another scheme", `Basic ${CRON_SECRET}`],
    ["the secret with a suffix", `Bearer ${CRON_SECRET}x`],
  ])("refuses %s with a 401", async (_name, authorization) => {
    t = await startApp();

    const res = await t.request(
      "/cron/sweep",
      authorization === undefined ? {} : { headers: { authorization } },
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  test("disconnects a stale connection: its key revoked, its row and user gone", async () => {
    await startWithFake();
    const { userId, key } = await connection();
    later(STALE_AFTER_MS);

    const res = await sweep();

    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({
      disconnected: 1,
      failed: 0,
      clientsDeleted: 0,
      more: false,
    });
    expect(fake.revokedKeys()).toEqual([key]);
    expect(await t.connections.getByUserId(userId)).toBeNull();
    expect(await userIds()).toEqual([]);
  });

  test("keeps a connection whose deployment is down, for the next run to retry", async () => {
    await startWithFake();
    const { userId } = await connection();
    later(STALE_AFTER_MS);
    answer = () => Response.json({ error: "unavailable" }, { status: 503 });

    const res = await sweep();

    expect(await res.json()).toStrictEqual({
      disconnected: 0,
      failed: 1,
      clientsDeleted: 0,
      more: false,
    });
    expect(await t.connections.getByUserId(userId)).not.toBeNull();
    expect(await userIds()).toEqual([userId]);

    answer = undefined;
    expect(await (await sweep()).json()).toMatchObject({
      disconnected: 1,
      failed: 0,
    });
    expect(await userIds()).toEqual([]);
  });

  test("drops a connection whose key the deployment already refuses", async () => {
    await startWithFake();
    const { userId, key } = await connection();
    fake.revoke(key);
    later(STALE_AFTER_MS);

    const res = await sweep();

    expect(await res.json()).toMatchObject({ disconnected: 1, failed: 0 });
    expect(await t.connections.getByUserId(userId)).toBeNull();
    expect(await userIds()).toEqual([]);
  });

  test("drops a connection whose key won't decrypt, sending the deployment nothing", async () => {
    let sent = 0;
    t = await startApp({
      lookup: async () => "public",
      fetch: async () => {
        sent++;
        return new Response(null, { status: 204 });
      },
    });
    const { connectQuery } = await authorizeChatApp(t);
    const { userId } = await t.auth.connectionSignIn(connectQuery);
    // sealed under a secret since rotated away
    await connectionStore(
      t.db,
      "q83vASNFZ4mrze8BI0VniTyAm5kVJ6XL3e8kI0VniQ8=",
    ).create({
      userId,
      deploymentUrl: DEPLOYMENT,
      release: "1.4.0",
      key: "bgc_sealed-under-the-old-secret",
    });
    later(STALE_AFTER_MS);

    const res = await sweep();

    expect(await res.json()).toMatchObject({ disconnected: 1, failed: 0 });
    expect(sent).toBe(0);
    expect((await t.db.execute("SELECT id FROM connection")).rows).toHaveLength(
      0,
    );
    expect(await userIds()).toEqual([]);
  });

  test("runs batches until none is full, counting a connection that failed in each once", async () => {
    await startWithFake();
    for (let i = 0; i < TWO_BATCHES; i++) await registeredClient();
    await connection();
    later(UNUSED_CLIENT_AFTER_MS);
    answer = () => new Response(null, { status: 503 });

    const res = await sweep();

    expect(await res.json()).toStrictEqual({
      disconnected: 0,
      failed: 1,
      clientsDeleted: TWO_BATCHES,
      more: false,
    });
  });

  test("starts no batch once 45 seconds have passed, answering that more remain", async () => {
    await startWithFake();
    for (let i = 0; i < TWO_BATCHES; i++) await registeredClient();
    await connection();
    later(UNUSED_CLIENT_AFTER_MS);
    answer = () => {
      vi.advanceTimersByTime(46_000);
      return new Response(null, { status: 204 });
    };

    const res = await sweep();

    expect(await res.json()).toStrictEqual({
      disconnected: 1,
      failed: 0,
      clientsDeleted: 25,
      more: true,
    });
  });

  test("deletes connect attempts abandoned over an hour ago, and keeps a later one", async () => {
    t = await startApp();
    const attempt = (state: string, expiresAt: Date) =>
      t.pendingConnects.create({
        state,
        oauthQuery: "client_id=abandoned",
        codeVerifier: "verifier",
        deploymentUrl: DEPLOYMENT,
        release: "1.4.0",
        expiresAt,
      });
    await attempt(
      "abandoned-61-minutes-ago",
      new Date(Date.now() - 61 * 60_000),
    );
    await attempt(
      "abandoned-59-minutes-ago",
      new Date(Date.now() - 59 * 60_000),
    );

    await sweep();

    const left = await t.db.execute("SELECT state FROM pending_connect");
    expect(left.rows.map((row) => String(row.state))).toEqual([
      "abandoned-59-minutes-ago",
    ]);
  });

  test("logs the run's counts, and no user, address or key", async () => {
    await startWithFake();
    const { userId, key } = await connection();
    later(STALE_AFTER_MS);
    t.lines.length = 0;

    await sweep();

    expect(t.lines.map((line) => JSON.parse(line))).toStrictEqual([
      {
        event: "sweep",
        disconnected: 1,
        failed: 0,
        clientsDeleted: 0,
        more: false,
      },
      expect.objectContaining({ event: "request", route: "/cron/sweep" }),
    ]);
    for (const line of t.lines) {
      expect(line).not.toContain(userId);
      expect(line).not.toContain(key);
      expect(line).not.toContain("hopeshelter");
    }
  });

  test("a refused call leaves a stale connection in place", async () => {
    await startWithFake();
    const { userId } = await connection();
    later(STALE_AFTER_MS);

    await sweep("Bearer not-the-cron-secret-0123456789abcdef");

    expect(fake.revokedKeys()).toEqual([]);
    expect(await userIds()).toEqual([userId]);
  });
});
