import { inspect } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { createApp } from "./app.ts";
import { createDb, migrate } from "./db/index.ts";
import type { DeploymentNetwork } from "./deployment/index.ts";
import { appDeps } from "./deps.ts";
import type { Env } from "./env.ts";
import {
  createFakeDeployment,
  type FakeActionMode,
  type FakeDeployment,
  type FakeDeploymentOptions,
} from "./fake-deployment/app.ts";
import { consoleSink, createLogger } from "./log.ts";
import {
  authorizeChatApp,
  callTool,
  PUBLIC_URL,
  redeemChatAppCode,
  type TestApp,
} from "./test-app.ts";

// The whole app, driven the way a chat app and an operator drive it, with a marker in
// everything that must stay out of a log line, a header or a response that has no business
// carrying it: the deployment's key, the PKCE verifiers, the codes and states, the OAuth
// tokens, the app's two secrets, a donor's name and email, and a distinctive tool argument
// and result. Everything the app logs, everything written to console.* and
// process.stdout/stderr, and every response header and body is scanned for them.
//
// Each test is scanned for the markers it planted (afterEach); the last test scans the whole
// run and fails, rather than passes empty, when a scenario above it didn't run.

// --- markers -----------------------------------------------------------------

type Sink = "log" | "output" | "header" | "location" | "body";
interface Entry {
  sink: Sink;
  /** the request path a header or body answered; empty for what was written */
  path: string;
  scenario: string;
  text: string;
}

/**
 * Where a marker may legitimately show up, and nowhere else:
 * - `mcp`: the body of a `/mcp` answer, where a tool's arguments and result go back to the chat
 * - `token`: the body of the token endpoint, which hands the chat app its tokens
 * - `connect-page`: the body of the address page, which carries the chat app's signed query
 * - `location`: a redirect, which carries the codes and states the next hop needs
 */
type Allowed = "mcp" | "token" | "connect-page" | "location";

interface Marker {
  label: string;
  value: string;
  allowed: Allowed[];
}

const markers: Marker[] = [];

function plant(label: string, value: string, ...allowed: Allowed[]): string {
  // "" is in every text: a marker that was never found would pass everything
  if (value === "") throw new Error(`no value to plant for ${label}`);
  const known = markers.find((marker) => marker.value === value);
  if (known === undefined) markers.push({ label, value, allowed });
  else known.allowed = [...new Set([...known.allowed, ...allowed])];
  return value;
}

/** A tool argument or result value: the chat may be handed it back, a log may not. */
const arg = (name: string) =>
  plant(`arg:${name}`, `leak-arg-${name}-4f2a`, "mcp");
/** What the operator types in the address box: the page shows it again beside the error. */
const typed = (name: string) =>
  plant(`typed:${name}`, `leak-typed-${name}-4f2a`, "connect-page");
const DONOR_EMAIL = plant(
  "donor-email",
  "leak-donor-email-4f2a@example.org",
  "mcp",
);
const AMOUNT = plant("amount", "739142", "mcp");
/** What a deployment says to the connector and the connector must not pass on. */
const HIDDEN = plant("hidden-answer", "leak-hidden-answer-c3a8");
/** A refusal's own `message` is worded for the chat on purpose; its other fields stay behind. */
const REFUSAL_MESSAGE = plant(
  "refusal-message",
  "leak-refusal-message-5d7e",
  "mcp",
);

/** `CONNECTION_KEY_SECRET` is 32 bytes, base64: the marker is the base64 and the bytes behind it. */
function plantKeySecret(label: string, bytes: string): string {
  expect(Buffer.byteLength(bytes)).toBe(32);
  plant(`${label}:raw`, bytes);
  return plant(label, Buffer.from(bytes).toString("base64"));
}

const ENV: Env = {
  PUBLIC_URL,
  TURSO_DATABASE_URL: ":memory:",
  BETTER_AUTH_SECRET: plant(
    "env:BETTER_AUTH_SECRET",
    "leak-marker-better-auth-secret-7c1e0f2a9d",
  ),
  CONNECTION_KEY_SECRET: plantKeySecret(
    "env:CONNECTION_KEY_SECRET",
    "leak-marker-connection-secret-ab",
  ),
  CRON_SECRET: plant(
    "env:CRON_SECRET",
    "leak-marker-cron-secret-5b9e3d71c0a4f286",
  ),
};
const ROTATED_KEY_SECRET = plantKeySecret(
  "env:rotated-CONNECTION_KEY_SECRET",
  "leak-marker-rotated-secret-abcde",
);

// the chat app's own state, which its callback gets back and the address page's signed query holds
const CHAT_STATE = plant(
  "chat-state",
  "claude-state-1",
  "location",
  "connect-page",
);

// --- what was written and what was answered --------------------------------------

const trace: Entry[] = [];

const record = (sink: Sink, text: string, path = "") =>
  trace.push({
    sink,
    path,
    scenario: expect.getState().currentTestName ?? "",
    text,
  });

const permits: Record<Allowed, (entry: Entry) => boolean> = {
  mcp: (e) => e.sink === "body" && e.path === "/mcp",
  token: (e) => e.sink === "body" && e.path === "/api/auth/oauth2/token",
  "connect-page": (e) => e.sink === "body" && e.path === "/connect",
  location: (e) => e.sink === "location",
};

interface Leak {
  marker: string;
  sink: Sink;
  path: string;
  scenario: string;
  near: string;
}

function leaksIn(entries: Entry[]): Leak[] {
  return entries.flatMap((entry) =>
    markers
      .filter(
        (marker) =>
          entry.text.includes(marker.value) &&
          !marker.allowed.some((allowed) => permits[allowed](entry)),
      )
      .map((marker) => {
        const at = entry.text.indexOf(marker.value);
        return {
          marker: marker.label,
          sink: entry.sink,
          path: entry.path,
          scenario: entry.scenario,
          near: entry.text.slice(Math.max(0, at - 40), at + 60),
        };
      }),
  );
}

let mark = 0;
const expectNoLeaks = (from = mark) =>
  expect(leaksIn(trace.slice(from))).toEqual([]);

const textOfChunk = (chunk: unknown) =>
  chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : String(chunk);

const CONSOLE_METHODS = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
  "dir",
  "table",
] as const;
let stopCapture: () => void = () => {};

function startCapture() {
  const spies = [
    ...CONSOLE_METHODS.map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        record(
          "output",
          args
            .map((a) =>
              typeof a === "string" ? a : inspect(a, { depth: null }),
            )
            .join(" "),
        );
      }),
    ),
    ...([process.stdout, process.stderr] as const).map((stream) =>
      vi.spyOn(stream, "write").mockImplementation(((
        chunk: unknown,
        encoding?: unknown,
        done?: unknown,
      ) => {
        record("output", textOfChunk(chunk));
        const callback = typeof encoding === "function" ? encoding : done;
        if (typeof callback === "function") callback();
        return true;
      }) as typeof stream.write),
    ),
  ];
  stopCapture = () => {
    for (const spy of spies) spy.mockRestore();
  };
}

beforeAll(startCapture);
afterAll(() => stopCapture());

// --- the app under test ----------------------------------------------------------------

const HOST = "give.hopeshelter.org";

class StoreDown extends Error {
  override name = "StoreDown";
}

interface WorldOptions {
  fake?: Partial<FakeDeploymentOptions>;
  lookup?: DeploymentNetwork["lookup"];
}

async function startWorld({
  fake: fakeOptions = {},
  lookup,
}: WorldOptions = {}) {
  const fake = createFakeDeployment({
    returnTo: `${PUBLIC_URL}/connect/return`,
    ...fakeOptions,
  });
  /** answers a request to the deployment instead of the fake; undefined passes it on */
  let intercept: (
    url: string,
    init: RequestInit,
  ) => Response | Promise<Response> | undefined = () => undefined;
  const network: DeploymentNetwork = {
    lookup: lookup ?? (async () => "public"),
    fetch: async (url, init) => {
      if (url.endsWith("/connector/v1/exchange")) {
        const sent = JSON.parse(String(init.body)) as {
          code: string;
          code_verifier: string;
        };
        plant("deployment-code", sent.code);
        plant("connector-verifier", sent.code_verifier);
      }
      return (await intercept(url, init)) ?? fake.app.request(url, init);
    },
  };

  const db = createDb({ url: ":memory:" });
  await migrate(db);
  let failing: { match: RegExp; error: Error } | null = null;
  const flaky = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop !== "execute") return value.bind(target);
      return (statement: string | { sql: string }, ...rest: unknown[]) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (failing?.match.test(sql)) return Promise.reject(failing.error);
        return value.call(target, statement, ...rest);
      };
    },
  });

  const lines: string[] = [];
  // the logger as the entries wire it, plus a copy under its own sink
  const log = createLogger((line, level) => {
    lines.push(line);
    record("log", line);
    consoleSink(line, level);
  });

  /** The app over `secret`, its answers recorded. */
  async function appOver(connectionKeySecret: string) {
    const deps = appDeps(
      { ...ENV, CONNECTION_KEY_SECRET: connectionKeySecret },
      flaky,
      log,
      network,
    );
    // better-auth writes its seed rows as it starts: warm it before a test can close the database
    await deps.auth.handler(
      new Request(`${PUBLIC_URL}/.well-known/oauth-authorization-server`),
    );
    const app = createApp(deps);
    const request = async (path: string, init?: RequestInit) => {
      const res = await app.request(`${PUBLIC_URL}${path}`, init);
      const answered = path.split("?")[0] ?? path;
      for (const [name, value] of res.headers) {
        if (name === "location") record("location", value, answered);
        else record("header", `${name}: ${value}`, answered);
      }
      for (const cookie of res.headers.getSetCookie()) {
        record("header", `set-cookie: ${cookie}`, answered);
      }
      record("body", await res.clone().text(), answered);
      return res;
    };
    const t: TestApp = { db, app, lines, request, ...deps };
    return t;
  }

  const t = await appOver(ENV.CONNECTION_KEY_SECRET);
  return {
    t,
    fake,
    lines,
    /** This app again over the same database, under another connection-key secret. */
    rotated: () => appOver(ROTATED_KEY_SECRET),
    intercept: (answer: typeof intercept) => {
      intercept = answer;
    },
    failOn: (match: RegExp, error: Error) => {
      failing = { match, error };
    },
    browse: browser(t),
  };
}

type World = Awaited<ReturnType<typeof startWorld>>;
let world: World;

/** The operator's browser: it sends back the cookies the app set it. */
function browser(t: TestApp) {
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

beforeEach(async () => {
  mark = trace.length;
  world = await startWorld();
  return () => world.t.db.close();
});

afterEach(() => {
  for (const key of world.fake.mintedKeys()) {
    plant("deployment-key", key);
    plant("deployment-key:body", key.replace(/^bgc_/, ""));
  }
  expectNoLeaks();
});

// --- the chat app and the operator ------------------------------------------------------

const location = (res: Response) => res.headers.get("location") ?? "";

/** The chat app authorized and the operator pressing Continue with `address` typed. */
async function enterAddress(w: World, address = HOST) {
  const authorization = await authorizeChatApp(w.t);
  plant("chat-verifier", authorization.verifier);
  const res = await w.browse(`/connect?${authorization.connectQuery}`, {
    method: "POST",
    headers: { origin: PUBLIC_URL },
    body: new URLSearchParams({ address }),
  });
  return { authorization, res };
}

/** The operator pressing a button on the deployment's Allow screen; where it sends the browser back. */
async function pressOnAllow(
  w: World,
  allowUrl: string,
  decision: "allow" | "cancel",
) {
  plant(
    "connect-state",
    new URL(allowUrl).searchParams.get("state") ?? "",
    "location",
  );
  const decided = await w.fake.app.request(allowUrl, {
    method: "POST",
    body: new URLSearchParams({ decision }),
  });
  const back = new URL(location(decided));
  if (decision === "allow") {
    plant("deployment-code", back.searchParams.get("code") ?? "");
  }
  return `${back.pathname}${back.search}`;
}

/** The operator reaching Allow, pressing `decision`, and the browser coming back: the app's answer. */
async function walkToReturn(w: World, decision: "allow" | "cancel" = "allow") {
  const { authorization, res } = await enterAddress(w);
  expect(res.status).toBe(303);
  const back = await pressOnAllow(w, location(res), decision);
  return { authorization, back, returned: await w.browse(back) };
}

/** A full connection: the chat app's tokens, its code and the tokens planted. */
async function connect(w: World) {
  const { authorization, returned } = await walkToReturn(w);
  expect(returned.status).toBe(303);
  const redirectTo = location(returned);
  plant(
    "chat-code",
    new URL(redirectTo).searchParams.get("code") ?? "",
    "location",
  );
  const { accessToken, refreshToken } = await redeemChatAppCode(
    w.t,
    authorization,
    redirectTo,
  );
  plant("token:access", accessToken, "token");
  plant("token:refresh", refreshToken, "token");
  return accessToken;
}

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
}

/** What each tool has done in this run: it answered, and it was refused. */
const seen = new Map<string, { answered: boolean; refused: boolean }>();

async function call(
  accessToken: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const result = (await callTool(
    world.t,
    accessToken,
    name,
    args,
  )) as ToolResult;
  const known = seen.get(name) ?? { answered: false, refused: false };
  if (result.isError === true) known.refused = true;
  else known.answered = true;
  seen.set(name, known);
  return result;
}

const textOf = (result: ToolResult) =>
  result.content.map(({ text }) => text).join("\n");

/** The id and version a write answered, for the next call to name. */
function idAndVersion(result: ToolResult) {
  const { id, version } = result.structuredContent ?? {};
  return { id: String(id), version: String(version) };
}

const post = (
  accessToken: string | undefined,
  method: string,
  params?: unknown,
) =>
  world.t.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken === undefined
        ? {}
        : { authorization: `Bearer ${accessToken}` }),
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

/** The tools `/mcp` lists, after the chat app has connected. */
async function listedTools(accessToken: string): Promise<string[]> {
  const res = await post(accessToken, "tools/list");
  const text = await res.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  const { result } = JSON.parse(data === undefined ? text : data.slice(6)) as {
    result: { tools: { name: string }[] };
  };
  return result.tools.map(({ name }) => name);
}

// --- the instruments work ---------------------------------------------------------

// The probe is the one place besides src/log.ts that writes to the console.
function writeToConsole(
  method: (typeof CONSOLE_METHODS)[number],
  line: unknown,
) {
  console[method](line);
}

test("the capture sees the logger, console, stdout/stderr, a header and a body, and the scan names where a marker showed up", async () => {
  const canary = plant("canary", "leak-canary-0000");
  const before = trace.length;

  for (const method of CONSOLE_METHODS) {
    writeToConsole(method, `${method} ${canary}`);
    writeToConsole(method, { nested: { method, canary } });
  }
  process.stdout.write(`stdout ${canary}\n`);
  process.stderr.write(Buffer.from(`stderr ${canary}\n`));
  world.t.log({ event: "tool_call", tool: canary, outcome: "ok" });
  await world.t.request(`/${canary}`);

  const written = trace.slice(before);
  const sinks = new Set(written.map((entry) => entry.sink));
  expect(sinks).toEqual(new Set(["output", "log", "header", "body"]));
  // 16 console calls, stdout, stderr, and the logger's own line on its way to the console
  expect(
    written.filter(
      (entry) => entry.sink === "output" && entry.text.includes(canary),
    ),
  ).toHaveLength(19);
  expect(written.find((entry) => entry.sink === "header")?.text).toMatch(
    /^[a-z-]+: /,
  );
  expect(leaksIn(written).map((leak) => leak.marker)).toEqual(
    Array(written.filter((entry) => entry.text.includes(canary)).length).fill(
      "canary",
    ),
  );
  trace.length = before;
});

test("a marker is allowed only where it was planted for", () => {
  const entry = (sink: Sink, path: string, text: string): Entry => ({
    sink,
    path,
    scenario: "",
    text,
  });

  const leaks = leaksIn([
    entry("body", "/mcp", arg("probe")),
    entry("body", "/connect", arg("probe")),
    entry("header", "/mcp", `x-echo: ${arg("probe")}`),
    entry("log", "", arg("probe")),
    entry("body", "/mcp", HIDDEN),
    entry("location", "/connect", HIDDEN),
    entry("location", "/connect/return", CHAT_STATE),
    entry("header", "/connect", `x-echo: ${CHAT_STATE}`),
  ]);

  expect(
    leaks.map(({ sink, path, marker }) => `${sink} ${path} ${marker}`),
  ).toEqual([
    "body /connect arg:probe",
    "header /mcp arg:probe",
    "log  arg:probe",
    "body /mcp hidden-answer",
    "location /connect hidden-answer",
    "header /connect chat-state",
  ]);
});

// --- the connect walk --------------------------------------------------------------------

test("a full connection through the connect flow, then initialize and tools/list", async () => {
  const accessToken = await connect(world);

  const init = await post(accessToken, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "chat-app", version: "1.0.0" },
  });
  const tools = await listedTools(accessToken);

  expect(init.status).toBe(200);
  expect(tools).toContain("record_gift");
  expect(world.fake.mintedKeys()).toHaveLength(1);
});

test("a denial at Allow, then the way back to Allow", async () => {
  const { returned } = await walkToReturn(world, "cancel");
  const resultPath = location(returned);
  const result = await world.browse(resultPath);

  expect(resultPath).toMatch(/^\/connect\/result\?outcome=cancelled-retry/);
  const retry = new URLSearchParams(resultPath.split("?")[1]).get("attempt");
  expect(result.status).toBe(200);
  expect(await result.text()).toContain(`state=${retry}`);
});

test("an address that isn't one", async () => {
  const notAnAddress = await enterAddress(
    world,
    `${typed("not-an-address")} charity`,
  );

  expect(notAnAddress.res.status).toBe(422);
});

test("a host that doesn't exist", async () => {
  world = await startWorld({ lookup: async () => "no_such_host" });

  const { res } = await enterAddress(world, `${typed("no-such-host")}.example`);

  expect(res.status).toBe(422);
});

test.each<[string, (w: World) => void, WorldOptions?]>([
  [
    "a site that is down",
    (w) =>
      w.intercept(() => {
        throw new TypeError(`fetch failed ${HIDDEN}`);
      }),
  ],
  [
    "a site that isn't Better Giving",
    (w) =>
      w.intercept(() => new Response(`<h1>${HIDDEN}</h1>`, { status: 404 })),
  ],
  [
    "a release from before the connector contract",
    () => undefined,
    { fake: { hello: null } },
  ],
])("an address meeting %s", async (_, arrange, options) => {
  if (options !== undefined) world = await startWorld(options);
  arrange(world);

  const { res } = await enterAddress(world);

  expect(res.status).toBe(422);
});

test.each<[string, (w: World) => void, WorldOptions?]>([
  [
    "a 503 page",
    (w) =>
      w.intercept((url) =>
        url.endsWith("/exchange")
          ? new Response(HIDDEN, { status: 503 })
          : undefined,
      ),
  ],
  [
    "a refusal with fields of its own",
    (w) =>
      w.intercept((url) =>
        url.endsWith("/exchange")
          ? Response.json(
              {
                error: "unavailable",
                message: HIDDEN,
                detail: HIDDEN,
                trace: HIDDEN,
              },
              { status: 500 },
            )
          : undefined,
      ),
  ],
  [
    "a key-less success",
    (w) =>
      w.intercept((url) =>
        url.endsWith("/exchange") ? Response.json({ name: HIDDEN }) : undefined,
      ),
  ],
  [
    "a site that stops answering",
    (w) =>
      w.intercept((url) => {
        if (url.endsWith("/exchange"))
          throw new TypeError(`timed out ${HIDDEN}`);
        return undefined;
      }),
  ],
  [
    "a spent code",
    (w) =>
      w.intercept((url) =>
        url.endsWith("/exchange")
          ? Response.json(
              { error: "invalid_code", message: HIDDEN, fix: HIDDEN },
              { status: 400 },
            )
          : undefined,
      ),
  ],
])("a return whose exchange meets %s", async (_, arrange) => {
  const { res } = await enterAddress(world);
  const back = await pressOnAllow(world, location(res), "allow");
  arrange(world);

  const returned = await world.browse(back);

  expect(location(returned)).toMatch(/^\/connect\/result\?outcome=/);
});

test("a replayed return", async () => {
  const { back, returned } = await walkToReturn(world);
  expect(returned.status).toBe(303);

  const replay = await world.browse(back);

  expect(location(replay)).toMatch(/^\/connect\/result\?outcome=unconfirmed/);
});

test("an unexpected throw while storing the attempt", async () => {
  world.failOn(
    /INSERT INTO pending_connect/i,
    new StoreDown(`pending ${HIDDEN}`),
  );

  const { res } = await enterAddress(world);

  expect(res.status).toBe(500);
});

test("an unexpected throw while storing the connection", async () => {
  const { res } = await enterAddress(world);
  const back = await pressOnAllow(world, location(res), "allow");
  world.failOn(/INSERT INTO connection/i, new StoreDown(`insert ${HIDDEN}`));

  const returned = await world.browse(back);

  expect(location(returned)).toMatch(/^\/connect\/result\?outcome=failed/);
});

// --- every tool, answered --------------------------------------------------------

test("every tool answers with sentinel arguments, and the chat is handed the results", async () => {
  const accessToken = await connect(world);
  const listed = await listedTools(accessToken);
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(accessToken, name, args);
    expect({ name, isError: result.isError }).toEqual({
      name,
      isError: undefined,
    });
    return result;
  };

  await ok("connection_status");
  await ok("get_page_catalog");
  const created = idAndVersion(
    await ok("create_campaign", {
      name: arg("campaign-name"),
      campaign_type: "emergency",
    }),
  );
  const renamed = idAndVersion(
    await ok("rename_campaign", {
      campaign_id: created.id,
      version: created.version,
      name: arg("campaign-rename"),
    }),
  );
  const edited = idAndVersion(
    await ok("edit_campaign_page", {
      campaign_id: created.id,
      version: renamed.version,
      document: {
        name: arg("page-name"),
        blocks: [
          { id: "blk_text", type: "story", text: arg("block-text") },
          { id: "blk_give", type: "donation-box" },
        ],
      },
    }),
  );
  const photo = await ok("get_photo_upload_link", {
    target: "campaign",
    campaign_id: created.id,
    block_id: arg("block-id"),
  });
  plant("photo-link", String(photo.structuredContent?.url), "mcp");
  const published = idAndVersion(
    await ok("publish_campaign", {
      campaign_id: created.id,
      version: edited.version,
      gifts_go_to: null,
    }),
  );
  await ok("get_campaign", { campaign_id: created.id });
  await ok("list_campaigns");
  await ok("get_campaign_results", { campaign_id: created.id });
  const unpublished = idAndVersion(
    await ok("unpublish_campaign", {
      campaign_id: created.id,
      version: published.version,
    }),
  );
  const discarded = idAndVersion(
    await ok("discard_campaign_changes", {
      campaign_id: created.id,
      version: unpublished.version,
    }),
  );
  const republished = idAndVersion(
    await ok("publish_campaign", {
      campaign_id: created.id,
      version: discarded.version,
    }),
  );
  await ok("end_campaign", {
    campaign_id: created.id,
    version: republished.version,
  });
  await ok("get_campaign", { campaign_id: created.id });
  // only a campaign that never went live can be deleted
  const spare = idAndVersion(
    await ok("create_campaign", {
      name: arg("spare-campaign"),
      campaign_type: "other",
    }),
  );
  await ok("delete_campaign", {
    campaign_id: spare.id,
    version: spare.version,
  });

  const page = idAndVersion(await ok("get_donation_page"));
  const pageEdited = idAndVersion(
    await ok("edit_donation_page", {
      version: page.version,
      document: {
        name: arg("page-heading"),
        blocks: [{ id: "blk_give", type: "donation-box" }],
      },
    }),
  );
  const pagePublished = idAndVersion(
    await ok("publish_donation_page", { version: pageEdited.version }),
  );
  await ok("reset_donation_page", { version: pagePublished.version });

  await ok("list_forms");
  const form = idAndVersion(
    await ok("create_form", {
      name: arg("form-name"),
      suggested_amounts_minor: [2500],
      allowed_origins: [`https://${arg("form-origin")}.example`],
    }),
  );
  const formEdited = idAndVersion(
    await ok("edit_form", {
      form_id: form.id,
      version: form.version,
      name: arg("form-rename"),
    }),
  );
  await ok("get_form", { form_id: form.id });
  await ok("archive_form", { form_id: form.id, version: formEdited.version });
  await ok("list_programs");

  const gift = await ok("record_gift", {
    donor: { new: { name: arg("donor-name"), email: DONOR_EMAIL } },
    amount_minor: Number(AMOUNT),
    dated: "2031-04-17",
    method: "check",
    note: arg("gift-note"),
  });
  await ok("list_gifts", { since: "2031-04-01" });
  await ok("list_donors", { q: arg("donor-name") });
  const donor = await ok("get_donor", {
    donor_id: String(gift.structuredContent?.donor_id),
  });
  await ok("list_recurring_gifts");
  await ok("get_results", { from: "2031-04-01", to: "2031-04-30" });

  expect(textOf(donor)).toContain(arg("donor-name"));
  expect(textOf(donor)).toContain(DONOR_EMAIL);
  expect(textOf(gift)).toContain(arg("gift-note"));
  for (const name of listed) expect(seen.get(name)?.answered, name).toBe(true);
});

/** Every tool that reaches a deployment, with arguments that carry markers. */
const REFUSAL_ARGS = (): Record<string, Record<string, unknown>> => {
  const campaign_id = arg("unknown-campaign");
  const version = arg("version");
  const document = {
    name: arg("refused-page-name"),
    blocks: [{ id: "b1", type: "story", text: arg("refused-block-text") }],
  };
  return {
    list_campaigns: { cursor: arg("campaigns-cursor") },
    get_campaign: { campaign_id },
    create_campaign: { name: arg("refused-campaign"), campaign_type: "event" },
    rename_campaign: {
      campaign_id,
      version,
      name: arg("refused-rename"),
      slug: arg("slug"),
    },
    edit_campaign_page: { campaign_id, version, document },
    discard_campaign_changes: { campaign_id, version },
    publish_campaign: { campaign_id, version, gifts_go_to: arg("program") },
    unpublish_campaign: { campaign_id, version },
    end_campaign: { campaign_id, version },
    delete_campaign: { campaign_id, version },
    get_donation_page: {},
    edit_donation_page: { version, document },
    publish_donation_page: { version },
    reset_donation_page: { version },
    get_page_catalog: {},
    get_photo_upload_link: {
      target: "campaign",
      campaign_id,
      block_id: arg("refused-block"),
    },
    list_forms: { cursor: arg("forms-cursor") },
    get_form: { form_id: arg("unknown-form") },
    create_form: {
      name: arg("refused-form"),
      allowed_origins: [`https://${arg("refused-origin")}.example`],
    },
    edit_form: {
      form_id: arg("unknown-form"),
      version,
      name: arg("refused-form-rename"),
    },
    archive_form: { form_id: arg("unknown-form"), version },
    list_programs: { cursor: arg("programs-cursor") },
    list_donors: { q: arg("donor-query"), cursor: arg("donors-cursor") },
    get_donor: { donor_id: arg("unknown-donor") },
    list_gifts: {
      cursor: arg("gifts-cursor"),
      form_id: arg("gift-form"),
      since: "2031-04-01",
    },
    record_gift: {
      donor: { id: arg("unknown-donor") },
      amount_minor: Number(AMOUNT),
      dated: "2031-04-17",
      method: "cash",
      note: arg("refused-note"),
    },
    list_recurring_gifts: { cursor: arg("recurring-cursor") },
    get_results: { from: "2031-04-01", to: "2031-04-30" },
    get_campaign_results: { campaign_id },
  };
};

test("the refusal table names every tool that reaches a deployment", async () => {
  const accessToken = await connect(world);

  const listed = await listedTools(accessToken);

  expect(Object.keys(REFUSAL_ARGS()).sort()).toEqual(
    listed.filter((name) => name !== "connection_status").sort(),
  );
});

test("sentinel arguments naming records no deployment has are refused with the deployment's own words", async () => {
  const accessToken = await connect(world);
  const names = [
    "get_campaign",
    "get_donor",
    "get_form",
    "rename_campaign",
    "record_gift",
    "get_photo_upload_link",
  ];

  for (const name of names) {
    const result = await call(accessToken, name, REFUSAL_ARGS()[name]);
    expect({ name, isError: result.isError }).toEqual({ name, isError: true });
  }
});

test.each<[FakeActionMode, string]>([
  ["older_release", "Update Better Giving"],
  ["down", "didn't answer"],
  ["rate_limited", "too many requests"],
])("every tool meeting a deployment that is %s", async (mode, said) => {
  const accessToken = await connect(world);
  world.fake.answerActions(mode);

  for (const [name, args] of Object.entries(REFUSAL_ARGS())) {
    const result = await call(accessToken, name, args);
    expect({ name, isError: result.isError }).toEqual({ name, isError: true });
    expect(textOf(result)).toContain(said);
  }
});

test.each<[string, (w: World) => Response]>([
  [
    "a refusal with fields of its own",
    () =>
      Response.json(
        {
          error: "validation_failed",
          message: REFUSAL_MESSAGE,
          fix: "Fix it.",
          detail: HIDDEN,
          trace: HIDDEN,
        },
        { status: 422 },
      ),
  ],
  ["a 5xx page", () => new Response(`upstream ${HIDDEN}`, { status: 502 })],
  ["a 200 that isn't JSON", () => new Response(`<html>${HIDDEN}</html>`)],
  ["a 403 page", () => new Response(`<h1>${HIDDEN}</h1>`, { status: 403 })],
  [
    "a site that is down",
    () => {
      throw new TypeError(`fetch failed ${HIDDEN}`);
    },
  ],
])("a read and a write meeting %s", async (_, answer) => {
  const accessToken = await connect(world);
  world.intercept((url) =>
    url.includes("/connector/v1/") ? answer(world) : undefined,
  );

  const read = await call(
    accessToken,
    "list_donors",
    REFUSAL_ARGS().list_donors,
  );
  const write = await call(
    accessToken,
    "record_gift",
    REFUSAL_ARGS().record_gift,
  );

  expect([read.isError, write.isError]).toEqual([true, true]);
});

test("a write meeting a refused key says reconnect, drops the connection and ends the chat app's tokens", async () => {
  const accessToken = await connect(world);
  for (const key of world.fake.mintedKeys()) world.fake.revoke(key);

  const result = await call(
    accessToken,
    "record_gift",
    REFUSAL_ARGS().record_gift,
  );
  const after = await post(accessToken, "tools/list");

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("Reconnect Better Giving");
  expect(after.status).toBe(401);
});

test("a read meeting a refused key says reconnect", async () => {
  const accessToken = await connect(world);
  for (const key of world.fake.mintedKeys()) world.fake.revoke(key);

  const result = await call(
    accessToken,
    "list_donors",
    REFUSAL_ARGS().list_donors,
  );

  expect(textOf(result)).toContain("Reconnect Better Giving");
});

test("unexpected throws while reading the connection and while dropping it", async () => {
  const accessToken = await connect(world);
  for (const key of world.fake.mintedKeys()) world.fake.revoke(key);
  world.failOn(/DELETE FROM connection/i, new StoreDown(`drop ${HIDDEN}`));
  const dropping = await call(
    accessToken,
    "list_donors",
    REFUSAL_ARGS().list_donors,
  );
  world.failOn(/FROM connection WHERE/i, new StoreDown(`read ${HIDDEN}`));

  const reading = await call(
    accessToken,
    "record_gift",
    REFUSAL_ARGS().record_gift,
  );

  expect(dropping.isError).toBe(true);
  expect(textOf(reading)).toContain("The tool failed on the server");
});

// --- the door: the connection key's secret and the bearer ---------------------------------

test("a connection whose key can't be opened ends without a trace of the key", async () => {
  const accessToken = await connect(world);
  const rotated = await world.rotated();

  const res = await rotated.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_donors", arguments: REFUSAL_ARGS().list_donors },
    }),
  });
  const after = await post(accessToken, "tools/list");

  expect(await res.text()).toContain("Reconnect Better Giving");
  expect(after.status).toBe(401);
});

test("a JWT-shaped bearer, a garbage bearer and a damaged real token are all refused", async () => {
  const real = await connect(world);
  const b64url = (text: string) => Buffer.from(text).toString("base64url");
  const jwt = plant(
    "bearer:jwt",
    [
      b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
      b64url(
        JSON.stringify({
          sub: plant("bearer:jwt-subject", "leak-jwt-subject-8e20"),
          iss: `${PUBLIC_URL}/api/auth`,
          aud: `${PUBLIC_URL}/mcp`,
          exp: 4102444800,
        }),
      ),
      b64url("leak-jwt-signature-8e20"),
    ].join("."),
  );
  const garbage = plant("bearer:garbage", "leak-garbage-bearer-77d0");
  // not the last character: a signature's last base64 character can carry bits that mean nothing
  const at = real.length - 8;
  const damaged = plant(
    "bearer:damaged",
    `${real.slice(0, at)}${real[at] === "a" ? "b" : "a"}${real.slice(at + 1)}`,
  );

  const statuses: number[] = [];
  for (const bearer of [jwt, garbage, damaged]) {
    for (const [method, params] of [
      [
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "chat-app", version: "1.0.0" },
        },
      ],
      [
        "tools/call",
        { name: "record_gift", arguments: REFUSAL_ARGS().record_gift },
      ],
    ] as const) {
      statuses.push((await post(bearer, method, params)).status);
    }
  }

  expect(statuses).toEqual(Array(6).fill(401));
});

test("a request with no bearer, and one from another origin, are refused", async () => {
  await connect(world);

  const bare = await post(undefined, "tools/list");
  const crossOrigin = await world.t.request("/mcp", {
    method: "POST",
    headers: {
      origin: `https://${arg("other-origin")}.example`,
      "content-type": "application/json",
    },
    body: "{}",
  });

  expect(bare.status).toBe(401);
  expect(crossOrigin.status).toBe(403);
});

// --- the whole run -----------------------------------------------------------------------

test("across the whole run nothing written or answered carries a marker, and every path above ran", async () => {
  // Runs after the scenarios above and fails, rather than passes empty, when they didn't
  // run (a name filter, a bail).
  const logged = trace
    .filter((entry) => entry.sink === "log")
    .map((entry) => JSON.parse(entry.text) as Record<string, string>);
  const outcomes = (event: string) =>
    new Set(
      logged.filter((line) => line.event === event).map((line) => line.outcome),
    );

  const accessToken = await connect(world);
  const listed = await listedTools(accessToken);

  for (const name of listed) {
    expect(seen.get(name)?.answered, `${name} answered`).toBe(true);
    // connection_status reads only this service's own row: a deployment can't refuse it
    if (name !== "connection_status") {
      expect(seen.get(name)?.refused, `${name} refused`).toBe(true);
    }
  }
  expect(outcomes("tool_call")).toEqual(new Set(["ok", "tool_error", "error"]));
  for (const outcome of [
    "handed-off",
    "connected",
    "cancelled-retry",
    "address-invalid",
    "no-such-host",
    "no-answer",
    "not-better-giving",
    "outdated",
    "unconfirmed",
    "failed",
    "deployment-down",
  ]) {
    expect(outcomes("connect_outcome"), outcome).toContain(outcome);
  }
  expect(new Set(logged.map((line) => line.event))).toEqual(
    new Set(["request", "tool_call", "connect_outcome", "unhandled_error"]),
  );
  expect(new Set(trace.map((entry) => entry.sink))).toEqual(
    new Set(["log", "output", "header", "location", "body"]),
  );

  expectNoLeaks(0);
});
