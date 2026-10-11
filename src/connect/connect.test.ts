import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConnectRequestInvalid } from "../auth/index.ts";
import type { DeploymentNetwork } from "../deployment/index.ts";
import {
  createFakeDeployment,
  type FakeDeployment,
  type FakeDeploymentOptions,
} from "../fake-deployment/app.ts";
import {
  authorizeChatApp,
  callTool,
  PUBLIC_URL,
  redeemChatAppCode,
  startApp,
  type TestApp,
} from "../test-app.ts";

let t: TestApp;
let fake: FakeDeployment;

/** The app with `fake` answering at every public host. */
async function startWithFake(options: Partial<FakeDeploymentOptions> = {}) {
  fake = createFakeDeployment({
    returnTo: `${PUBLIC_URL}/connect/return`,
    ...options,
  });
  t = await startApp({
    lookup: async () => "public",
    fetch: async (url, init) => fake.app.request(url, init),
  });
}

/** A browser's requests to the app: it sends back the cookies the app set it. */
function browser() {
  const cookies = new Map<string, string>();
  return async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookies.size > 0) {
      headers.set(
        "cookie",
        [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    const res = await t.request(path, { ...init, headers });
    for (const line of res.headers.getSetCookie()) {
      const [name = "", ...value] = (line.split(";")[0] ?? "").split("=");
      cookies.set(name, value.join("="));
    }
    return res;
  };
}

/** The operator's browser */
let browse: ReturnType<typeof browser>;

beforeEach(() => {
  browse = browser();
});

/** The operator pressing Continue with `address` typed, on the page this service served. */
function postAddress(
  connectQuery: string,
  address: string,
  from = browse,
  origin = PUBLIC_URL,
) {
  return from(`/connect?${connectQuery}`, {
    method: "POST",
    headers: { origin },
    body: new URLSearchParams({ address }),
  });
}

/** The operator pressing `decision` on the deployment's Allow screen; the URL it sends the browser back to. */
async function decide(allowUrl: string, decision: "allow" | "cancel") {
  const res = await fake.app.request(allowUrl, {
    method: "POST",
    body: new URLSearchParams({ decision }),
  });
  expect(res.status).toBe(303);
  const back = new URL(res.headers.get("location") ?? "");
  return `${back.pathname}${back.search}`;
}

/** The redirect `res` answers with. */
function location(res: Response): string {
  expect(res.status).toBe(303);
  return res.headers.get("location") ?? "";
}

/** The page's one `<input>` tag. */
function addressBox(page: string): string {
  return /<input [^>]*>/.exec(page)?.[0] ?? "";
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  t.db.close();
});

/** The page's `<main>`: what a refresh must show again, without the per-response style nonce. */
function mainOf(page: string): string {
  return /<main>.*<\/main>/s.exec(page)?.[0] ?? "";
}

/** The chat app authorized, the operator sent on to Allow; the Allow URL. */
async function handedOff() {
  const authorization = await authorizeChatApp(t);
  const allowUrl = location(
    await postAddress(authorization.connectQuery, "give.hopeshelter.org"),
  );
  return { authorization, allowUrl };
}

/** The result page a return lands on, after its 303. */
async function resultOf(returnPath: string, from = browse) {
  const resultPath = location(await from(returnPath));
  expect(resultPath).toMatch(/^\/connect\/result\?/);
  const res = await from(resultPath);
  expect(res.status).toBe(200);
  return { resultPath, page: await res.text() };
}

describe("GET /connect", () => {
  test("from the chat app's authorize shows the address form, posting back with the signed query", async () => {
    t = await startApp();
    const { connectQuery } = await authorizeChatApp(t);

    const res = await browse(`/connect?${connectQuery}`);

    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<title>Connect Better Giving</title>");
    expect(page).toContain(
      `<form method="post" action="/connect?${connectQuery.replaceAll("&", "&amp;")}" novalidate="">`,
    );
    expect(page).toContain(
      '<label for="address">Donation page address</label>',
    );
    expect(addressBox(page)).toContain('name="address" value=""');
    expect(addressBox(page)).not.toContain("aria-invalid");
  });
});

describe("/connect outside a chat app's Connect", () => {
  test.each(["/connect", "/connect?state=x", "/connect/return"])(
    "GET %s asks to start from the chat app",
    async (path) => {
      t = await startApp();

      const res = await browse(path);

      expect(res.status).toBe(200);
      expect(mainOf(await res.text())).toContain(
        "<h1>Start from your chat app</h1>",
      );
    },
  );
});

describe("POST /connect", () => {
  test.each([
    {
      name: "another site's page",
      headers: { origin: "https://evil.example" },
    },
    {
      name: "another site's page that sends no Origin",
      headers: { "sec-fetch-site": "cross-site" },
    },
  ])("from $name is refused and starts nothing", async ({ headers }) => {
    await startWithFake();
    const { connectQuery } = await authorizeChatApp(t);

    const res = await browse(`/connect?${connectQuery}`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ address: "give.hopeshelter.org" }),
    });

    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toStrictEqual([]);
    expect(
      (await t.db.execute("SELECT state FROM pending_connect")).rows,
    ).toHaveLength(0);
  });

  test("binds the attempt to the browser with a host-only, HttpOnly, Lax cookie", async () => {
    await startWithFake();
    const { connectQuery } = await authorizeChatApp(t);

    const res = await postAddress(connectQuery, "give.hopeshelter.org");

    expect(res.status).toBe(303);
    const [cookie] = res.headers.getSetCookie();
    expect(cookie).toMatch(/^__Host-[\w-]+=[\w-]{43}; /);
    expect(cookie?.split("; ").slice(1).sort()).toStrictEqual(
      ["HttpOnly", "Max-Age=900", "Path=/", "SameSite=Lax", "Secure"].sort(),
    );
  });

  test("with under 2 minutes left says time ran out and sends the operator nowhere", async () => {
    await startWithFake();
    const { connectQuery } = await authorizeChatApp(t);
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.now() + 8.5 * 60 * 1000,
      shouldAdvanceTime: true,
    });

    const res = await postAddress(connectQuery, "give.hopeshelter.org");

    expect(res.status).toBe(200);
    expect(mainOf(await res.text())).toContain("<h1>Time ran out</h1>");
    expect(
      (await t.db.execute("SELECT state FROM pending_connect")).rows,
    ).toHaveLength(0);
  });

  const answering =
    (response: () => Response): DeploymentNetwork["fetch"] =>
    async () =>
      response();
  const fakeAnswering = (
    options: Partial<FakeDeploymentOptions>,
  ): DeploymentNetwork["fetch"] => {
    const deployment = createFakeDeployment({
      returnTo: `${PUBLIC_URL}/connect/return`,
      ...options,
    });
    return async (url, init) => deployment.app.request(url, init);
  };

  test.each<{
    typed: string;
    network?: Partial<DeploymentNetwork>;
    error: string;
  }>([
    { typed: "   ", error: "required" },
    {
      typed: "give hopeshelter",
      error: "not a web address — type it like give.yourcharity.org",
    },
    {
      typed: "localhost",
      error: "not a web address — type it like give.yourcharity.org",
    },
    {
      typed: "192.168.1.20",
      error: "not a web address — type it like give.yourcharity.org",
    },
    {
      typed: "ops@hopeshelter.org",
      error: "that&#39;s an email address — type your donation page address",
    },
    {
      typed: "give.hopeshleter.org",
      network: { lookup: async () => "no_such_host" },
      error: "no site at this address — check the spelling",
    },
    {
      typed: "give.hopeshelter.org",
      network: { lookup: async () => "not_public" },
      error: "the site didn&#39;t answer — try again in a minute",
    },
    {
      typed: "give.hopeshelter.org",
      network: {
        fetch: answering(() => new Response("down", { status: 503 })),
      },
      error: "the site didn&#39;t answer — try again in a minute",
    },
    {
      typed: "hopeshelter.org",
      network: {
        fetch: answering(
          () =>
            new Response("<!doctype html><title>Hope Shelter</title>", {
              status: 200,
            }),
        ),
      },
      error:
        "not a Better Giving site — use the address donors give on, not your main website",
    },
    {
      typed: "give.hopeshelter.org",
      network: { fetch: fakeAnswering({ hello: null }) },
      error:
        "needs a newer Better Giving — update Better Giving, then start again from the chat app",
    },
    {
      typed: "give.hopeshelter.org",
      network: {
        fetch: fakeAnswering({
          hello: { revision: 0, release: null, org_name: "Hope Shelter" },
        }),
      },
      error:
        "needs a newer Better Giving — update Better Giving, then start again from the chat app",
    },
  ])(
    "with $typed shows “$error” under the box it keeps",
    async ({ typed, network, error }) => {
      t = await startApp({
        lookup: async () => "public",
        fetch: answering(() => new Response("unexpected", { status: 500 })),
        ...network,
      });
      const { connectQuery } = await authorizeChatApp(t);

      const res = await postAddress(connectQuery, typed);

      expect(res.status).toBe(422);
      const page = await res.text();
      expect(page).toContain(
        "<title>Check the address · Connect Better Giving</title>",
      );
      expect(addressBox(page)).toContain(`value="${typed}"`);
      expect(addressBox(page)).toContain('aria-invalid="true"');
      expect(addressBox(page)).toContain(
        'aria-describedby="address-hint address-error"',
      );
      expect(page).toContain(
        `<p id="address-error" class="error">${error}</p>`,
      );
    },
  );
});

describe("the connect flow", () => {
  test("connects: address, Allow, return, then /mcp reaches the deployment with the key Allow minted", async () => {
    await startWithFake();
    const authorization = await authorizeChatApp(t);

    const allowUrl = new URL(
      location(
        await postAddress(authorization.connectQuery, " give.hopeshelter.org "),
      ),
    );
    expect(`${allowUrl.origin}${allowUrl.pathname}`).toBe(
      "https://give.hopeshelter.org/connector/allow",
    );
    expect(allowUrl.searchParams.get("return_to")).toBe(
      `${PUBLIC_URL}/connect/return`,
    );
    expect(allowUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const returned = await browse(await decide(allowUrl.href, "allow"));
    const { accessToken } = await redeemChatAppCode(
      t,
      authorization,
      location(returned),
    );

    expect(await callTool(t, accessToken, "connection_status")).toMatchObject({
      structuredContent: {
        deploymentUrl: "https://give.hopeshelter.org",
        release: "1.4.0",
      },
    });
    const [key] = fake.mintedKeys();
    const rows = await t.db.execute(
      "SELECT user_id, key_ciphertext FROM connection",
    );
    expect(rows.rows).toHaveLength(1);
    expect(
      Buffer.from(rows.rows[0]?.key_ciphertext as ArrayBuffer).includes(
        key ?? "",
      ),
    ).toBe(false);
    expect(
      (await t.connections.getByUserId(String(rows.rows[0]?.user_id)))?.key,
    ).toBe(key);
  });
});

describe("GET /connect/return", () => {
  test("after Cancel offers a fresh way back to Allow, which still connects", async () => {
    await startWithFake();
    const { authorization, allowUrl } = await handedOff();

    const { page } = await resultOf(await decide(allowUrl, "cancel"));

    expect(page).toContain("<title>Not connected · Better Giving</title>");
    expect(page).toContain("Pressed Cancel by mistake?");
    const again = /<a href="([^"]+)">Go back to Allow<\/a>/.exec(page)?.[1];
    const retryUrl = new URL((again ?? "").replaceAll("&amp;", "&"));
    expect(`${retryUrl.origin}${retryUrl.pathname}`).toBe(
      "https://give.hopeshelter.org/connector/allow",
    );
    expect(retryUrl.searchParams.get("state")).not.toBe(
      new URL(allowUrl).searchParams.get("state"),
    );
    const connected = await browse(await decide(retryUrl.href, "allow"));
    await redeemChatAppCode(t, authorization, location(connected));
  });

  test("with a state no attempt has says it couldn't connect", async () => {
    await startWithFake();

    const { page } = await resultOf("/connect/return?state=unknown&code=abc");

    expect(page).toContain(
      "<title>Couldn&#39;t connect · Better Giving</title>",
    );
    expect(page).toContain(
      "Your dashboard&#39;s answer couldn&#39;t be confirmed, so the chat app isn&#39;t connected.",
    );
  });

  test("replayed after connecting says it couldn't connect, and leaves the connection", async () => {
    await startWithFake();
    const { allowUrl } = await handedOff();
    const returnPath = await decide(allowUrl, "allow");
    location(await browse(returnPath));

    const { page } = await resultOf(returnPath);

    expect(page).toContain("<h1>Couldn&#39;t connect</h1>");
    const rows = await t.db.execute("SELECT id FROM connection");
    expect(rows.rows).toHaveLength(1);
  });

  test("whose code the deployment refuses says it couldn't connect", async () => {
    await startWithFake();
    const { allowUrl } = await handedOff();
    const back = new URL(await decide(allowUrl, "allow"), PUBLIC_URL);
    back.searchParams.set("code", "not-the-code-allow-sent");

    const { page } = await resultOf(`${back.pathname}${back.search}`);

    expect(page).toContain("<h1>Couldn&#39;t connect</h1>");
  });

  test("when the exchange fails on the deployment says the donation page didn't answer", async () => {
    await startWithFake({ exchangeFailure: 502 });
    const { allowUrl } = await handedOff();

    const { page } = await resultOf(await decide(allowUrl, "allow"));

    expect(page).toContain(
      "<title>Something went wrong · Better Giving</title>",
    );
    expect(page).toContain(
      "Your donation page didn&#39;t answer while connecting, so the chat app isn&#39;t connected.",
    );
  });

  test("after the 10 minutes says time ran out, and revokes the key the late Allow minted", async () => {
    await startWithFake();
    const { allowUrl } = await handedOff();
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.now() + 11 * 60 * 1000,
      shouldAdvanceTime: true,
    });

    const { page } = await resultOf(await decide(allowUrl, "allow"));

    expect(page).toContain("<title>Time ran out · Better Giving</title>");
    expect(fake.mintedKeys()).toHaveLength(1);
    expect(fake.revokedKeys()).toStrictEqual(fake.mintedKeys());
    expect((await t.db.execute("SELECT id FROM connection")).rows).toHaveLength(
      0,
    );
  });

  test("after Cancel past the 10 minutes says not connected, with no way back to Allow", async () => {
    await startWithFake();
    const { allowUrl } = await handedOff();
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.now() + 11 * 60 * 1000,
      shouldAdvanceTime: true,
    });

    const { page } = await resultOf(await decide(allowUrl, "cancel"));

    expect(page).toContain("<h1>Not connected</h1>");
    expect(page).not.toContain("Go back to Allow");
    expect(page).toContain("Go back to the chat app and press Connect again.");
  });

  test("when the chat app's authorization can't resume revokes the key and stores no connection", async () => {
    await startWithFake();
    const { allowUrl } = await handedOff();
    vi.spyOn(t.auth, "connectionSignIn").mockRejectedValue(
      new ConnectRequestInvalid(),
    );

    const { page } = await resultOf(await decide(allowUrl, "allow"));

    expect(page).toContain("<h1>Couldn&#39;t connect</h1>");
    expect(fake.revokedKeys()).toStrictEqual(fake.mintedKeys());
    expect((await t.db.execute("SELECT id FROM connection")).rows).toHaveLength(
      0,
    );
  });

  test("when the connection can't be stored revokes the key and removes the connection-user", async () => {
    await startWithFake();
    const { allowUrl } = await handedOff();
    vi.spyOn(t.connections, "create").mockRejectedValue(
      new Error("disk I/O error"),
    );

    const { page } = await resultOf(await decide(allowUrl, "allow"));

    expect(page).toContain(
      "Connecting failed on our side, so the chat app isn&#39;t connected.",
    );
    expect(fake.revokedKeys()).toStrictEqual(fake.mintedKeys());
    const users = await t.db.execute(
      "SELECT id FROM user WHERE email LIKE '%@connection.invalid'",
    );
    expect(users.rows).toHaveLength(0);
    expect(t.lines.map((line) => JSON.parse(line))).toContainEqual({
      event: "unhandled_error",
      method: "GET",
      route: "/connect/return",
      errorName: "Error",
    });
  });
});

describe("GET /connect/result", () => {
  test("shows the same outcome on a refresh", async () => {
    await startWithFake();
    const { allowUrl } = await handedOff();
    const { resultPath, page } = await resultOf(
      await decide(allowUrl, "cancel"),
    );

    const refreshed = await (await browse(resultPath)).text();

    expect(mainOf(refreshed)).toBe(mainOf(page));
    expect(mainOf(page)).toContain("Go back to Allow");
  });

  test("with an outcome it doesn't know sends the operator back to the chat app", async () => {
    await startWithFake();

    const res = await browse("/connect/result?outcome=connected");

    expect(await res.text()).toContain("<h1>Start from your chat app</h1>");
  });
});

describe("the connect flow's secrets", () => {
  test("reach no page, no redirect back to this service and no log line", async () => {
    await startWithFake();
    const seen: string[] = [];
    const record = async (res: Response) => {
      seen.push(res.headers.get("location") ?? "", await res.clone().text());
      return res;
    };
    const authorization = await authorizeChatApp(t);
    await record(await browse(`/connect?${authorization.connectQuery}`));
    await record(await postAddress(authorization.connectQuery, "nope"));
    const allowUrl = location(
      await postAddress(authorization.connectQuery, "give.hopeshelter.org"),
    );
    const state = new URL(allowUrl).searchParams.get("state") ?? "";
    const pending = await t.db.execute(
      "SELECT code_verifier FROM pending_connect",
    );
    const verifier = String(pending.rows[0]?.code_verifier);
    const returnPath = await decide(allowUrl, "allow");
    const code = new URL(returnPath, PUBLIC_URL).searchParams.get("code") ?? "";
    await record(await browse(returnPath));
    await record(await browse(returnPath)).then(async (res) =>
      record(await browse(res.headers.get("location") ?? "")),
    );
    const [key] = fake.mintedKeys();

    expect(t.lines.map((line) => JSON.parse(line))).toContainEqual({
      event: "connect_outcome",
      outcome: "connected",
    });
    for (const secret of [
      state,
      verifier,
      code,
      key ?? "",
      authorization.connectQuery,
    ]) {
      expect(secret.length).toBeGreaterThan(20);
      for (const line of t.lines) expect(line).not.toContain(secret);
    }
    for (const secret of [state, verifier, code, key ?? ""]) {
      for (const text of seen) expect(text).not.toContain(secret);
    }
  });
});

describe("GET /connect/return that can't be tied to this browser's attempt at that deployment", () => {
  /** `returnPath` with its `iss` set to `iss`, or removed when undefined. */
  function withIss(returnPath: string, iss: string | undefined) {
    const back = new URL(returnPath, PUBLIC_URL);
    if (iss === undefined) back.searchParams.delete("iss");
    else back.searchParams.set("iss", iss);
    return `${back.pathname}${back.search}`;
  }

  test.each([
    { name: "another site's iss", iss: "https://give.evil.example" },
    { name: "no iss", iss: undefined },
  ])(
    "with $name says it couldn't connect and exchanges nothing",
    async ({ iss }) => {
      await startWithFake();
      const { allowUrl } = await handedOff();

      const { page } = await resultOf(
        withIss(await decide(allowUrl, "allow"), iss),
      );

      expect(page).toContain("<h1>Couldn&#39;t connect</h1>");
      expect(fake.exchanges()).toBe(0);
    },
  );

  test("late, with another site's iss, says it couldn't connect and exchanges nothing", async () => {
    await startWithFake();
    const { allowUrl } = await handedOff();
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.now() + 11 * 60 * 1000,
      shouldAdvanceTime: true,
    });

    const { page } = await resultOf(
      withIss(await decide(allowUrl, "allow"), "https://give.evil.example"),
    );

    expect(page).toContain("<h1>Couldn&#39;t connect</h1>");
    expect(fake.exchanges()).toBe(0);
  });

  test.each([
    { name: "no cookie", otherBrowserStarts: false },
    { name: "another attempt's cookie", otherBrowserStarts: true },
  ])(
    "in a browser with $name says it couldn't connect and exchanges nothing",
    async ({ otherBrowserStarts }) => {
      await startWithFake();
      const { allowUrl } = await handedOff();
      const other = browser();
      if (otherBrowserStarts) {
        const { connectQuery } = await authorizeChatApp(t);
        location(
          await postAddress(connectQuery, "give.hopeshelter.org", other),
        );
      }

      const { page } = await resultOf(await decide(allowUrl, "allow"), other);

      expect(page).toContain("<h1>Couldn&#39;t connect</h1>");
      expect(fake.exchanges()).toBe(0);
      expect(
        (await t.db.execute("SELECT id FROM connection")).rows,
      ).toHaveLength(0);
    },
  );
});
