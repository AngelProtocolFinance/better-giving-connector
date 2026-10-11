import { afterEach, describe, expect, test, vi } from "vitest";
import { connectionStore } from "../db/index.ts";
import { PUBLIC_URL, signIn, startApp, type TestApp } from "../test-app.ts";

let t: TestApp;

afterEach(() => {
  vi.restoreAllMocks();
  t.db.close();
});

/** The 2025-era handshake Claude opens with. */
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw-test", version: "1.0.0" },
  },
};

/** One JSON-RPC message POSTed to `/mcp` as a streamable HTTP client sends it. */
function post(message: unknown, headers: Record<string, string> = {}) {
  return t.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(message),
  });
}

/** Every JSON-RPC response in a body sent as JSON or as server-sent events. */
async function rpcResponses(response: Response): Promise<unknown[]> {
  const text = await response.text();
  const payloads = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as unknown)
    : [JSON.parse(text) as unknown];
  return payloads.flat();
}

/** Headers a signed-in 2025-era client sends after the handshake. */
async function signedIn() {
  const { userId, accessToken, refreshToken } = await signIn(t);
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "mcp-protocol-version": "2025-06-18",
  };
  return { userId, accessToken, refreshToken, headers };
}

/** `connection_status` called as a signed-in client calls it, its one JSON-RPC result. */
async function callConnectionStatus(headers: Record<string, string>) {
  const res = await post(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "connection_status", arguments: {} },
    },
    headers,
  );
  expect(res.status).toBe(200);
  const [response] = (await rpcResponses(res)) as [{ result: unknown }];
  return response.result;
}

describe("POST /mcp", () => {
  test("whose token can't be checked answers 500, not a 401 that would send the chat app to sign in again", async () => {
    t = await startApp();
    const { headers } = await signedIn();
    t.db.close();

    const res = await post(INITIALIZE, headers);

    expect(res.status).toBe(500);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  test("from a page on another origin answers 403, even with a valid token", async () => {
    t = await startApp();
    const { headers } = await signedIn();

    const res = await post(INITIALIZE, {
      ...headers,
      origin: "https://evil.example",
    });

    expect(res.status).toBe(403);
  });

  test("from a page on this origin is served", async () => {
    t = await startApp();
    const { headers } = await signedIn();

    const res = await post(INITIALIZE, { ...headers, origin: PUBLIC_URL });

    expect(res.status).toBe(200);
  });

  test("with no bearer token answers 401 with the challenge naming the resource metadata", async () => {
    t = await startApp();

    const res = await post(INITIALIZE);

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});

describe("POST /mcp body", () => {
  test("over the size bound answers 413 before any MCP message is read", async () => {
    t = await startApp();
    const { headers } = await signedIn();

    const res = await post(
      { ...INITIALIZE, padding: "x".repeat(512 * 1024) },
      headers,
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "body_too_large" });
  });
});

/** The tool_call entries among the app's captured log lines. */
function toolCallLog(): unknown[] {
  return t.lines
    .map((line) => JSON.parse(line) as { event: string })
    .filter((entry) => entry.event === "tool_call");
}

describe("tool call logging", () => {
  test("logs each call's tool name and outcome", async () => {
    t = await startApp();
    const { userId, headers } = await signedIn();
    await callConnectionStatus(headers);
    await t.connections.create({
      userId,
      deploymentUrl: "https://give.example.org",
      release: "1.4.0",
      key: "bg_live_k3y-material-1234567890",
    });

    await callConnectionStatus(headers);

    expect(toolCallLog()).toStrictEqual([
      { event: "tool_call", tool: "connection_status", outcome: "tool_error" },
      { event: "tool_call", tool: "connection_status", outcome: "ok" },
    ]);
  });

  test("a whole session's log carries no token, tool argument or result", async () => {
    const consoleLines: string[] = [];
    for (const method of ["debug", "info", "log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      });
    }
    t = await startApp();
    const { userId, accessToken, refreshToken, headers } = await signedIn();
    await t.connections.create({
      userId,
      deploymentUrl: "https://give.example.org",
      release: "1.4.0-sekrit-release",
      key: "bg_live_k3y-material-1234567890",
    });

    await post(INITIALIZE, headers);
    const called = await post(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "connection_status",
          arguments: { note: "arg-sekrit-value" },
        },
      },
      headers,
    );
    await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, headers);

    expect(await called.text()).toContain("1.4.0-sekrit-release");
    expect(toolCallLog()).toHaveLength(1);
    const logged = [...t.lines, ...consoleLines].join("\n");
    for (const secret of [
      accessToken,
      refreshToken,
      "bg_live_k3y-material-1234567890",
      "give.example.org",
      "sekrit",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("a tool that fails on the server", () => {
  test("answers a generic tool error and logs only the error's class", async () => {
    t = await startApp();
    const { headers } = await signedIn();
    await t.db.execute("DROP TABLE connection");

    const result = await callConnectionStatus(headers);

    expect(result).toStrictEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "The tool failed on the server. Retry; if it keeps failing, tell the operator.",
        },
      ],
    });
    expect(toolCallLog()).toStrictEqual([
      {
        event: "tool_call",
        tool: "connection_status",
        outcome: "error",
        errorName: "LibsqlError",
        errorCode: "SQLITE_ERROR",
      },
    ]);
    expect(t.lines.join("\n")).not.toContain("no such table");
  });
});

describe("subscriptions/listen", () => {
  test("is refused in one JSON-RPC error: the tools never change, so no stream is held open", async () => {
    t = await startApp();
    const { headers } = await signedIn();

    const res = await post(
      { jsonrpc: "2.0", id: 7, method: "subscriptions/listen", params: {} },
      { ...headers, "mcp-protocol-version": "2026-07-28" },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32601,
        message:
          "subscriptions/listen is not offered: these tools never change, so there is nothing to notify.",
      },
    });
  });
});

describe("other methods on /mcp", () => {
  test.each(["GET", "DELETE"])(
    "%s answers 405: no stream or session is held",
    async (method) => {
      t = await startApp();

      const res = await t.request("/mcp", { method });

      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(await res.json()).toMatchObject({
        code: "method_not_allowed",
        detail: "Use POST.",
      });
    },
  );
});

describe("signed in", () => {
  test("initialize names the server Better Giving, and tools/list lists connection_status", async () => {
    t = await startApp();
    const { headers } = await signedIn();

    const initialized = await post(INITIALIZE, headers);
    const listed = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      headers,
    );

    expect(initialized.status).toBe(200);
    expect(await rpcResponses(initialized)).toMatchObject([
      { id: 1, result: { serverInfo: { name: "Better Giving" } } },
    ]);
    expect(listed.status).toBe(200);
    const [list] = (await rpcResponses(listed)) as [
      { result: { tools: { name: string }[] } },
    ];
    expect(list.result.tools.map((tool) => tool.name)).toEqual([
      "connection_status",
    ]);
  });
});

const RECONNECT = {
  isError: true,
  content: [
    {
      type: "text",
      text: "This chat isn't connected to a Better Giving deployment. Reconnect Better Giving in your chat app's connector settings, then try again.",
    },
  ],
};

describe("connection_status", () => {
  test("answers the connected deployment's address and release", async () => {
    t = await startApp();
    const { userId, headers } = await signedIn();
    await t.connections.create({
      userId,
      deploymentUrl: "https://give.example.org",
      release: "1.4.0",
      key: "bg_live_k3y-material-1234567890",
    });

    const result = await callConnectionStatus(headers);

    expect(result).toStrictEqual({
      content: [
        {
          type: "text",
          text: "Connected to the Better Giving deployment at https://give.example.org, release 1.4.0.",
        },
      ],
      structuredContent: {
        deploymentUrl: "https://give.example.org",
        release: "1.4.0",
      },
    });
  });

  test("with no connection stored answers a tool error telling the operator to reconnect", async () => {
    t = await startApp();
    const { headers } = await signedIn();

    expect(await callConnectionStatus(headers)).toStrictEqual(RECONNECT);
  });

  test("with a key the secret no longer opens answers the reconnect error, and drops the connection and its sign-in", async () => {
    t = await startApp();
    const { userId, headers } = await signedIn();
    const rotatedAway = Buffer.alloc(32, 9).toString("base64");
    await connectionStore(t.db, rotatedAway).create({
      userId,
      deploymentUrl: "https://give.example.org",
      release: "1.4.0",
      key: "bg_live_k3y-material-1234567890",
    });

    expect(await callConnectionStatus(headers)).toStrictEqual(RECONNECT);

    expect(await t.connections.getByUserId(userId)).toBeNull();
    const again = await post(INITIALIZE, headers);
    expect(again.status).toBe(401);
  });
});
