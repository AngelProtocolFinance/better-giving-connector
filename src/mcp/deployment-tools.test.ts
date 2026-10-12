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
  intercept: (
    url: string,
    init: RequestInit,
  ) => Response | Promise<Response> | undefined = () => undefined,
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
      return intercept(url, init) ?? fake.app.request(url, init);
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

/** A successful result's text: its summary line, and the JSON after it. */
function textOf(result: unknown) {
  const [{ text }] = (result as { content: [{ text: string }] }).content;
  const [summary, ...rest] = text.split("\n");
  return { summary, json: JSON.parse(rest.join("\n")) as unknown };
}

describe("create_campaign", () => {
  test("creates the campaign on the deployment and answers it, with a one-line summary", async () => {
    const { call } = await connected();

    const result = await call("create_campaign", {
      name: "Winter Coats",
      campaign_type: "emergency",
    });

    expect(result).toMatchObject({
      structuredContent: {
        name: "Winter Coats",
        campaign_type: "emergency",
        state: "never_published",
        editor_state: "unpublished",
        published: null,
      },
    });
    expect(textOf(result).summary).toBe(
      `Winter Coats: never_published, ${DEPLOYMENT}/c/winter-coats`,
    );
  });

  test("puts the whole answer in the text after the summary, for a client that passes only text", async () => {
    const { call } = await connected();

    const result = (await call("create_campaign", {
      name: "Winter Coats",
      campaign_type: "emergency",
    })) as { structuredContent: { id: string; version: string } };

    expect(textOf(result).json).toStrictEqual(result.structuredContent);
    expect(textOf(result).json).toMatchObject({
      id: expect.stringMatching(/^cmp_/),
      version: expect.any(String),
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

    expect(textOf(read).summary).toBe(
      `Winter Coats: live, ${DEPLOYMENT}/c/winter-coats`,
    );
    expect(read).toMatchObject({
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
          text: "This changed since the chat last read it. Read it again, then make the change.",
        },
      ],
    });
  });
});

type DonationPageResult = {
  structuredContent: {
    version: string;
    draft: unknown;
    published: unknown;
  };
};

describe("reset_donation_page", () => {
  test("replaces the live page and the draft with the starting page", async () => {
    const { call } = await connected();
    const start = (await call("get_donation_page")) as DonationPageResult;
    const edited = (await call("edit_donation_page", {
      version: start.structuredContent.version,
      document: DOCUMENT,
    })) as DonationPageResult;
    const published = (await call("publish_donation_page", {
      version: edited.structuredContent.version,
    })) as DonationPageResult;

    const reset = await call("reset_donation_page", {
      version: published.structuredContent.version,
    });

    expect(reset).toMatchObject({
      structuredContent: {
        editor_state: "live",
        draft: start.structuredContent.published,
        published: start.structuredContent.published,
      },
    });
  });
});

type FormResult = {
  structuredContent: { id: string; version: string; status: string };
};

describe("a form's life through the tools", () => {
  test("created, edited and archived reads back archived with the edit", async () => {
    const { call } = await connected();
    const created = (await call("create_form", {
      name: "Coat drive",
      suggested_amounts_minor: [2500, 5000],
    })) as FormResult;
    const { id } = created.structuredContent;

    const edited = (await call("edit_form", {
      form_id: id,
      version: created.structuredContent.version,
      min_minor: 1000,
    })) as FormResult;
    await call("archive_form", {
      form_id: id,
      version: edited.structuredContent.version,
    });
    const read = await call("get_form", { form_id: id });

    expect(textOf(read).summary).toBe("Coat drive: archived");
    expect(read).toMatchObject({
      structuredContent: {
        id,
        status: "archived",
        suggested_amounts_minor: [2500, 5000],
        min_minor: 1000,
      },
    });
  });

  test("an edit with a version the form has moved past answers the stale text", async () => {
    const { call } = await connected();
    const created = (await call("create_form", {
      name: "Coat drive",
    })) as FormResult;
    const { id, version } = created.structuredContent;
    await call("edit_form", { form_id: id, version, name: "Coats" });

    expect(
      await call("edit_form", { form_id: id, version, min_minor: 500 }),
    ).toStrictEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "This changed since the chat last read it. Read it again, then make the change.",
        },
      ],
    });
  });

  test("an edit to a form a page owns answers the deployment's message and fix", async () => {
    const { call } = await connected();
    const forms = (await call("list_forms")) as {
      structuredContent: {
        data: { id: string; version: string; owned_by_page_id: unknown }[];
      };
    };
    const owned = forms.structuredContent.data.find(
      (form) => form.owned_by_page_id !== null,
    );
    if (owned === undefined) throw new Error("the fake has no page-owned form");

    expect(
      await call("edit_form", {
        form_id: owned.id,
        version: owned.version,
        name: "Renamed",
      }),
    ).toStrictEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "This form belongs to a page, so it changes only with that page. Edit the page's donation box instead.",
        },
      ],
    });
  });
});

type ListResult = {
  structuredContent: {
    data: { id: string; name?: string }[];
    next_cursor: string | null;
  };
};

describe("list_donors", () => {
  test("reads every donor over two pages through next_cursor", async () => {
    const { call } = await connected();

    const first = (await call("list_donors", { limit: 2 })) as ListResult;
    const second = (await call("list_donors", {
      limit: 2,
      cursor: first.structuredContent.next_cursor,
    })) as ListResult;

    expect(textOf(first).summary).toBe(
      "2 donors. More on the next page: call again with next_cursor.",
    );
    expect(second.structuredContent.next_cursor).toBeNull();
    expect(
      [...first.structuredContent.data, ...second.structuredContent.data].map(
        ({ name }) => name,
      ),
    ).toStrictEqual(["Ana Ruiz", "Ben Okafor", "Chen Wei"]);
  });

  test("with q answers only the donors it matches", async () => {
    const { call } = await connected();

    const found = (await call("list_donors", { q: "okafor" })) as ListResult;

    expect(found.structuredContent.data.map(({ name }) => name)).toStrictEqual([
      "Ben Okafor",
    ]);
  });
});

describe("get_results", () => {
  test("answers the totals of the gifts dated from and to", async () => {
    const { call } = await connected();

    const result = await call("get_results", {
      from: "2026-09-01",
      to: "2026-09-30",
    });

    expect(textOf(result).summary).toBe(
      "2 gifts raising 25000 USD minor units; 2 new donors; 1 recurring gift active.",
    );
    expect(result).toMatchObject({
      structuredContent: {
        by_month: [{ month: "2026-09", raised_minor: 25000, gifts: 2 }],
      },
    });
  });
});

type GiftResult = { structuredContent: { id: string } };

/** What fetch throws when the client's `AbortSignal.timeout` fires. */
const timedOut = () =>
  new DOMException("The operation timed out.", "TimeoutError");

describe("record_gift", () => {
  test("records a gift per call, each sent with its own idempotency key", async () => {
    const keys: unknown[] = [];
    const { call } = await connected((url, init) => {
      if (url.endsWith("/connector/v1/gifts") && init.method === "POST") {
        keys.push(
          (JSON.parse(String(init.body)) as { idempotency_key?: unknown })
            .idempotency_key,
        );
      }
      return undefined;
    });
    const gift = {
      donor: { new: { name: "Dee Walsh" } },
      amount_minor: 2000,
      dated: "2026-10-03",
      method: "check",
    };

    const first = (await call("record_gift", gift)) as GiftResult;
    const second = (await call("record_gift", gift)) as GiftResult;
    const listed = (await call("list_gifts")) as ListResult;

    expect(textOf(first).summary).toBe(
      "Recorded a check gift of 2000 USD minor units, dated 2026-10-03.",
    );
    expect(first.structuredContent.id).not.toBe(second.structuredContent.id);
    expect(listed.structuredContent.data.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        first.structuredContent.id,
        second.structuredContent.id,
      ]),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("whose answer times out after the gift landed tells the chat to read it back, not to retry", async () => {
    const { call } = await connected((url, init) =>
      url.endsWith("/connector/v1/gifts") && init.method === "POST"
        ? (async () => {
            const landed = await fake.app.request(url, init);
            expect(landed.status).toBe(201);
            throw timedOut();
          })()
        : undefined,
    );

    const result = await call("record_gift", {
      donor: { id: "dnr_ana" },
      amount_minor: 2000,
      dated: "2026-10-03",
      method: "cash",
    });

    expect(result).toStrictEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Better Giving didn't answer, so this may or may not have gone through. Read it back before trying again.",
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

describe("two calls racing on a key the deployment refuses", () => {
  test("both answer the reconnect text and the connection and its sign-in end up gone, with nothing logged as an error", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    // the deployment answers neither call until both have read the connection and sent their request
    let arrived = 0;
    let bothArrived = () => {};
    const both = new Promise<void>((resolve) => {
      bothArrived = resolve;
    });
    const { call, key, userId, accessToken } = await connected((url, init) =>
      (async () => {
        arrived += 1;
        if (arrived === 2) bothArrived();
        await both;
        return fake.app.request(url, init);
      })(),
    );
    fake.revoke(key);

    const results = await Promise.all([
      call("list_campaigns"),
      call("get_donation_page"),
    ]);

    expect(results).toStrictEqual([RECONNECT, RECONNECT]);
    expect(await t.connections.getByUserId(userId)).toBeNull();
    expect(await initializeStatus(accessToken)).toBe(401);
    expect(
      t.lines
        .map((line) => JSON.parse(line) as { event: string; outcome?: string })
        .filter(
          ({ event, outcome }) =>
            event === "unhandled_error" || outcome === "error",
        ),
    ).toStrictEqual([]);
    expect(errors).toStrictEqual([]);
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

describe("a deployment on a release without /connector/v1", () => {
  test("answers its HTML 404 page with the update text and keeps the connection", async () => {
    const { call, userId } = await connected();
    fake.answerActions("before_connector");

    expect(await call("list_campaigns")).toStrictEqual({
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
        throw timedOut();
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

  test.each([
    ["an empty id", ""],
    ["an id with a lone surrogate", "cmp_\uD83D"],
  ])(
    "never leaves the connector for %s, which answers as a bad argument",
    async (_, id) => {
      const { call, sent } = await connected();

      const result = await call("get_campaign", { campaign_id: id });

      expect(result).toMatchObject({ isError: true });
      expect(sent).toStrictEqual([]);
      expect(t.lines.join("\n")).not.toContain('"outcome":"error"');
    },
  );

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
  test("lists a tool per action; the ten that need the operator's yes are destructive and say to ask first", async () => {
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

    // no refund, no change to a monthly gift, nothing the console holds: the contract has no route for them
    expect(tools.map(({ name }) => name).sort()).toStrictEqual([
      "archive_form",
      "connection_status",
      "create_campaign",
      "create_form",
      "delete_campaign",
      "discard_campaign_changes",
      "edit_campaign_page",
      "edit_donation_page",
      "edit_form",
      "end_campaign",
      "get_campaign",
      "get_campaign_results",
      "get_donation_page",
      "get_donor",
      "get_form",
      "get_page_catalog",
      "get_photo_upload_link",
      "get_results",
      "list_campaigns",
      "list_donors",
      "list_forms",
      "list_gifts",
      "list_programs",
      "list_recurring_gifts",
      "publish_campaign",
      "publish_donation_page",
      "record_gift",
      "rename_campaign",
      "reset_donation_page",
      "unpublish_campaign",
    ]);
    const needsAYes = tools.filter(
      ({ annotations }) => annotations.destructiveHint === true,
    );
    expect(needsAYes.map(({ name }) => name).sort()).toStrictEqual([
      "archive_form",
      "delete_campaign",
      "discard_campaign_changes",
      "edit_form",
      "end_campaign",
      "publish_campaign",
      "publish_donation_page",
      "rename_campaign",
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

  test("over forms, programs, results, donors and gifts carries no argument, result, donor, key or address", async () => {
    const consoleLines: string[] = [];
    for (const method of ["debug", "info", "log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      });
    }
    const idempotencyKeys: string[] = [];
    const { call, key } = await connected((url, init) => {
      if (url.endsWith("/connector/v1/gifts") && init.method === "POST") {
        idempotencyKeys.push(
          (JSON.parse(String(init.body)) as { idempotency_key: string })
            .idempotency_key,
        );
      }
      return undefined;
    });
    const form = (await call("create_form", {
      name: "Sekrit Form",
      allowed_origins: ["https://sekrit-origin.example"],
    })) as FormResult;
    const { id: formId, version } = form.structuredContent;
    await call("edit_form", { form_id: formId, version, min_minor: 777 });
    await call("get_form", { form_id: formId });
    await call("list_forms");
    await call("list_programs");
    const campaign = (await call("create_campaign", {
      name: "Sekrit Appeal",
      campaign_type: "other",
    })) as CampaignResult;
    await call("get_campaign_results", {
      campaign_id: campaign.structuredContent.id,
    });
    await call("get_results", { from: "2026-08-01", to: "2026-10-31" });
    const gift = (await call("record_gift", {
      donor: { new: { name: "Sekrit Donor", email: "sekrit@donor.example" } },
      amount_minor: 4242,
      dated: "2026-10-03",
      method: "check",
      note: "sekrit-check-1042",
    })) as GiftResult;
    await call("list_gifts", { since: "2026-10-01" });
    await call("list_donors", { q: "ana" });
    await call("get_donor", { donor_id: "dnr_ana" });
    await call("list_recurring_gifts");

    expect(
      t.lines
        .map((line) => JSON.parse(line) as { event: string })
        .filter(({ event }) => event === "tool_call"),
    ).toStrictEqual(
      [
        "create_form",
        "edit_form",
        "get_form",
        "list_forms",
        "list_programs",
        "create_campaign",
        "get_campaign_results",
        "get_results",
        "record_gift",
        "list_gifts",
        "list_donors",
        "get_donor",
        "list_recurring_gifts",
      ].map((tool) => ({ event: "tool_call", tool, outcome: "ok" })),
    );
    const logged = [...t.lines, ...consoleLines].join("\n").toLowerCase();
    for (const secret of [
      key,
      "hopeshelter",
      "sekrit",
      formId,
      gift.structuredContent.id,
      ...idempotencyKeys,
      "ana ruiz",
      "ana@example.org",
      "4242",
      "777",
    ]) {
      expect(logged).not.toContain(secret.toLowerCase());
    }
  });
});
