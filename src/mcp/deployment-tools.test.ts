import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createFakeDeployment,
  type FakeDeployment,
} from "../fake-deployment/app.ts";
import {
  callTool,
  PUBLIC_URL,
  signIn,
  startApp,
  type TestApp,
} from "../test-app.ts";

const DEPLOYMENT = "https://give.hopeshelter.org";

let t: TestApp;
let fake: FakeDeployment;

afterEach(() => {
  vi.restoreAllMocks();
  t.db.close();
});

/**
 * A signed-in chat app whose connection holds a key the fake deployment minted; every request the
 * app sends a deployment is recorded, and one `intercept` answers goes no further.
 */
async function connected(
  intercept: (url: string) => Response | undefined = () => undefined,
) {
  fake = createFakeDeployment({ returnTo: `${PUBLIC_URL}/connect/return` });
  const sent: {
    url: string;
    authorization: string | null;
    redirect: RequestInit["redirect"];
  }[] = [];
  t = await startApp({
    lookup: async () => "public",
    fetch: async (url, init) => {
      sent.push({
        url,
        authorization: new Headers(init.headers).get("authorization"),
        redirect: init.redirect,
      });
      return intercept(url) ?? fake.app.request(url, init);
    },
  });
  const { userId, accessToken } = await signIn(t);
  const key = fake.mintKey();
  await t.connections.create({
    userId,
    deploymentUrl: DEPLOYMENT,
    release: "1.4.0",
    key,
  });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    callTool(t, accessToken, name, args);
  return { userId, accessToken, key, call, sent };
}

describe("create_campaign", () => {
  test("creates the campaign on the deployment and answers it, with a one-line summary", async () => {
    const { call } = await connected();

    const result = await call("create_campaign", {
      name: "Winter Coats",
      campaign_type: "emergency",
    });

    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: `Winter Coats: never_published, ${DEPLOYMENT}/c/winter-coats`,
        },
      ],
      structuredContent: {
        name: "Winter Coats",
        campaign_type: "emergency",
        state: "never_published",
        editor_state: "unpublished",
        published: null,
      },
    });
  });
});

/** A page document the fake accepts: exactly one donation-box block. */
const DOCUMENT = {
  name: "Winter Coats",
  blocks: [
    { id: "blk_title", type: "title", text: "Coats for winter" },
    { id: "blk_give", type: "donation-box" },
  ],
};

type CampaignResult = {
  structuredContent: { id: string; version: string; state: string };
};

describe("a campaign's life through the tools", () => {
  test("created, edited and published reads back live; ended reads back ended", async () => {
    const { call } = await connected();
    const created = (await call("create_campaign", {
      name: "Winter Coats",
      campaign_type: "emergency",
    })) as CampaignResult;
    const { id } = created.structuredContent;

    const edited = (await call("edit_campaign_page", {
      campaign_id: id,
      version: created.structuredContent.version,
      document: DOCUMENT,
    })) as CampaignResult;
    const published = (await call("publish_campaign", {
      campaign_id: id,
      version: edited.structuredContent.version,
      gifts_go_to: null,
    })) as CampaignResult;
    const read = await call("get_campaign", { campaign_id: id });

    expect(read).toMatchObject({
      content: [
        {
          type: "text",
          text: `Winter Coats: live, ${DEPLOYMENT}/c/winter-coats`,
        },
      ],
      structuredContent: {
        id,
        state: "live",
        editor_state: "live",
        published: DOCUMENT,
      },
    });

    const ended = await call("end_campaign", {
      campaign_id: id,
      version: published.structuredContent.version,
    });

    expect(ended).toMatchObject({ structuredContent: { id, state: "ended" } });
  });

  test("a write with a version the page has moved past answers the stale text", async () => {
    const { call } = await connected();
    const created = (await call("create_campaign", {
      name: "Winter Coats",
      campaign_type: "emergency",
    })) as CampaignResult;
    const { id, version } = created.structuredContent;
    await call("rename_campaign", { campaign_id: id, version, name: "Coats" });

    const result = await call("edit_campaign_page", {
      campaign_id: id,
      version,
      document: DOCUMENT,
    });

    expect(result).toStrictEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "This page changed since the chat last read it. Read it again, then make the change.",
        },
      ],
    });
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

/** An `initialize` to `/mcp` with `accessToken`; its status. */
async function initializeStatus(accessToken: string) {
  const res = await t.request("/mcp", {
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
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw-test", version: "1.0.0" },
      },
    }),
  });
  await res.body?.cancel();
  return res.status;
}

describe("delete_campaign", () => {
  test("deletes a never-published campaign in one line; it reads back as not found", async () => {
    const { call } = await connected();
    const created = (await call("create_campaign", {
      name: "Winter Coats",
      campaign_type: "emergency",
    })) as CampaignResult;
    const { id, version } = created.structuredContent;

    expect(
      await call("delete_campaign", { campaign_id: id, version }),
    ).toStrictEqual({
      content: [{ type: "text", text: "Deleted the campaign." }],
    });
    expect(await call("get_campaign", { campaign_id: id })).toMatchObject({
      isError: true,
      content: [
        {
          text: `No campaign has the id ${id}. List the campaigns to get its id.`,
        },
      ],
    });
  });
});

describe("a key the deployment refuses", () => {
  test("answers the reconnect text, drops the connection and its sign-in, and the token stops working", async () => {
    const { call, key, userId, accessToken } = await connected();
    fake.revoke(key);

    expect(await call("list_campaigns")).toStrictEqual(RECONNECT);

    expect(await t.connections.getByUserId(userId)).toBeNull();
    expect(await initializeStatus(accessToken)).toBe(401);
  });
});

describe("a deployment on a release without the action", () => {
  test("answers the update text and keeps the connection", async () => {
    const { call, userId } = await connected();
    fake.answerActions("older_release");

    expect(await call("get_page_catalog")).toStrictEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Your Better Giving needs an update before the chat can do this. Update Better Giving, then try again.",
        },
      ],
    });
    expect(await t.connections.getByUserId(userId)).not.toBeNull();
  });
});

describe("a change the deployment refuses", () => {
  test("hands the chat the deployment's message and fix as they are", async () => {
    const { call } = await connected();
    const created = (await call("create_campaign", {
      name: "Winter Coats",
      campaign_type: "emergency",
    })) as CampaignResult;
    const { id, version } = created.structuredContent;

    const result = await call("edit_campaign_page", {
      campaign_id: id,
      version,
      document: {
        blocks: [
          { id: "a", type: "donation-box" },
          { id: "b", type: "donation-box" },
        ],
      },
    });

    expect(result).toStrictEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "document.blocks must hold exactly one donation-box block; it holds 2. Fix that field of the document; get_page_catalog has the rules.",
        },
      ],
    });
  });
});

const NO_ANSWER = {
  isError: true,
  content: [
    {
      type: "text",
      text: "Better Giving didn't answer. Try again in a minute.",
    },
  ],
};

describe("a deployment that doesn't answer", () => {
  test("with a 5xx answers the no-answer text and keeps the connection", async () => {
    const { call, userId } = await connected();
    fake.answerActions("down");

    expect(await call("list_campaigns")).toStrictEqual(NO_ANSWER);
    expect(await t.connections.getByUserId(userId)).not.toBeNull();
  });

  test("when the request fails or times out answers the no-answer text and keeps the connection", async () => {
    t = await startApp({
      lookup: async () => "public",
      fetch: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });
    const { userId, accessToken } = await signIn(t);
    await t.connections.create({
      userId,
      deploymentUrl: DEPLOYMENT,
      release: "1.4.0",
      key: `bgc_${"k".repeat(43)}`,
    });

    expect(await callTool(t, accessToken, "list_campaigns")).toStrictEqual(
      NO_ANSWER,
    );
    expect(await t.connections.getByUserId(userId)).not.toBeNull();
  });
});

describe("a deployment rate limiting the connector", () => {
  test("tells the chat to wait the seconds it names", async () => {
    const { call } = await connected();
    fake.answerActions("rate_limited");

    expect(await call("get_donation_page")).toStrictEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Better Giving is getting too many requests from the chat. Wait 30 seconds, then try again.",
        },
      ],
    });
  });
});

describe("the deployment's key", () => {
  test("goes only to the connection's own deployment", async () => {
    const { call, key, sent } = await connected();

    await call("list_campaigns");

    expect(sent).toStrictEqual([
      {
        url: `${DEPLOYMENT}/connector/v1/campaigns`,
        authorization: `Bearer ${key}`,
        // a real fetch would otherwise carry the key to wherever the deployment points
        redirect: "manual",
      },
    ]);
  });

  test("never reaches another action through a dot-segment id", async () => {
    const { call, sent } = await connected();

    const result = await call("get_campaign", { campaign_id: ".." });

    expect(result).toMatchObject({ isError: true });
    expect(sent).toStrictEqual([]);
  });

  test("doesn't follow the deployment's redirect", async () => {
    const { call, sent } = await connected((url) =>
      url.startsWith(DEPLOYMENT)
        ? new Response(null, {
            status: 307,
            headers: { location: "https://collector.example/campaigns" },
          })
        : undefined,
    );

    expect(await call("list_campaigns")).toStrictEqual(NO_ANSWER);
    expect(sent.map(({ url }) => url)).toStrictEqual([
      `${DEPLOYMENT}/connector/v1/campaigns`,
    ]);
  });
});

describe("tools/list", () => {
  test("lists a tool per action; the six that need the operator's yes are destructive and say to ask first", async () => {
    const { accessToken } = await connected();
    const res = await t.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const text = await res.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    const { tools } = (
      JSON.parse(data === undefined ? text : data.slice(6)) as {
        result: {
          tools: {
            name: string;
            description: string;
            annotations: Record<string, boolean>;
          }[];
        };
      }
    ).result;

    expect(tools.map(({ name }) => name).sort()).toStrictEqual([
      "connection_status",
      "create_campaign",
      "delete_campaign",
      "discard_campaign_changes",
      "edit_campaign_page",
      "edit_donation_page",
      "end_campaign",
      "get_campaign",
      "get_donation_page",
      "get_page_catalog",
      "get_photo_upload_link",
      "list_campaigns",
      "publish_campaign",
      "publish_donation_page",
      "rename_campaign",
      "reset_donation_page",
      "unpublish_campaign",
    ]);
    const needsAYes = tools.filter(
      ({ annotations }) => annotations.destructiveHint === true,
    );
    expect(needsAYes.map(({ name }) => name).sort()).toStrictEqual([
      "delete_campaign",
      "end_campaign",
      "publish_campaign",
      "publish_donation_page",
      "reset_donation_page",
      "unpublish_campaign",
    ]);
    for (const tool of needsAYes) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: false,
        openWorldHint: true,
      });
      expect(tool.description).toMatch(
        /^Ask the operator “[^”]+\?[^”]*” and call only after they say yes\./,
      );
    }
    const reads = tools.filter(
      ({ name }) =>
        /^(list|get)_/.test(name) && name !== "get_photo_upload_link",
    );
    expect(
      reads.map(({ annotations }) => annotations.readOnlyHint),
    ).toStrictEqual(reads.map(() => true));
  });
});

describe("the log", () => {
  test("carries each call's tool and outcome, and no argument, result, key or deployment address", async () => {
    const consoleLines: string[] = [];
    for (const method of ["debug", "info", "log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      });
    }
    const { call, key } = await connected();
    const created = (await call("create_campaign", {
      name: "Sekrit Appeal",
      campaign_type: "other",
    })) as CampaignResult;
    const { id, version } = created.structuredContent;
    await call("edit_campaign_page", {
      campaign_id: id,
      version,
      document: { blocks: [{ id: "sekrit-block", type: "story" }] },
    });
    await call("get_photo_upload_link", {
      target: "campaign",
      campaign_id: id,
      block_id: "blk_hero",
    });
    fake.revoke(key);
    await call("get_campaign", { campaign_id: id });

    expect(
      t.lines
        .map((line) => JSON.parse(line) as { event: string })
        .filter(({ event }) => event === "tool_call"),
    ).toStrictEqual([
      { event: "tool_call", tool: "create_campaign", outcome: "ok" },
      { event: "tool_call", tool: "edit_campaign_page", outcome: "tool_error" },
      { event: "tool_call", tool: "get_photo_upload_link", outcome: "ok" },
      { event: "tool_call", tool: "get_campaign", outcome: "tool_error" },
    ]);
    const logged = [...t.lines, ...consoleLines].join("\n").toLowerCase();
    for (const secret of [
      key,
      "hopeshelter",
      "sekrit",
      id,
      "/connector/photo/",
      "donation-box",
    ]) {
      expect(logged).not.toContain(secret.toLowerCase());
    }
  });
});
