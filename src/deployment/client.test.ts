import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import { deploymentClient } from "./client.ts";
import { DeploymentKey } from "./key.ts";
import { isPublicAddress, publicInternet } from "./network.ts";

const KEY = `bgc_${"k".repeat(43)}`;
const WRAPPED = new DeploymentKey(KEY);
const HELLO = {
  service: "better-giving",
  contract: "v1",
  revision: 1,
  release: "1.4.0",
  org_name: "Hope Shelter",
};

/** A network answering each URL from `routes`, recording every request it was sent. */
function network(
  routes: Record<string, () => Response>,
  privateHosts: string[] = [],
) {
  const sent: { url: string; authorization: string | null }[] = [];
  return {
    sent,
    client: deploymentClient({
      lookup: async (host) =>
        privateHosts.includes(host) ? "not_public" : "public",
      fetch: async (url, init) => {
        sent.push({
          url,
          authorization: new Headers(init.headers).get("authorization"),
        });
        return routes[url]?.() ?? new Response("not found", { status: 404 });
      },
    }),
  };
}

function redirectTo(location: string, status = 307) {
  return () => new Response(null, { status, headers: { location } });
}

describe("deploymentClient", () => {
  test("disconnect doesn't follow a redirect with the key", async () => {
    const { client, sent } = network({
      "https://give.hopeshelter.org/connector/v1/disconnect": redirectTo(
        "https://collector.example/connector/v1/disconnect",
      ),
    });

    expect(
      await client.disconnect("https://give.hopeshelter.org", WRAPPED),
    ).toBe(false);
    expect(sent.map(({ url }) => url)).toStrictEqual([
      "https://give.hopeshelter.org/connector/v1/disconnect",
    ]);
  });

  test("exchange doesn't follow a redirect with the code and verifier", async () => {
    const { client, sent } = network({
      "https://give.hopeshelter.org/connector/v1/exchange": redirectTo(
        "https://collector.example/connector/v1/exchange",
        308,
      ),
    });

    expect(
      await client.exchange("https://give.hopeshelter.org", "code", "verifier"),
    ).toStrictEqual({ ok: false, problem: "unexpected" });
    expect(sent).toHaveLength(1);
  });

  test("exchange answers the key wrapped, so rendering the answer shows [redacted]", async () => {
    const { client } = network({
      "https://give.hopeshelter.org/connector/v1/exchange": () =>
        Response.json({ key: KEY, org_name: "Hope Shelter" }),
    });

    const answer = await client.exchange(
      "https://give.hopeshelter.org",
      "code",
      "verifier",
    );

    expect(JSON.stringify(answer)).toBe('{"ok":true,"key":"[redacted]"}');
    expect(inspect(answer)).not.toContain(KEY);
    expect(answer.ok && answer.key.reveal()).toBe(KEY);
  });

  test("disconnect presents the key to the deployment", async () => {
    const { client, sent } = network({
      "https://give.hopeshelter.org/connector/v1/disconnect": () =>
        new Response(null, { status: 204 }),
    });

    expect(
      await client.disconnect("https://give.hopeshelter.org", WRAPPED),
    ).toBe(true);
    expect(sent[0]?.authorization).toBe(`Bearer ${KEY}`);
  });

  test.each([
    ["an HTML page", () => new Response("<h1>Not Found</h1>", { status: 404 })],
    ["no body", () => new Response(null, { status: 404 })],
    [
      "JSON that isn't the contract's refusal",
      () => Response.json({ message: "Not Found" }, { status: 404 }),
    ],
  ])(
    "act reads a 404 with %s as a release without the action",
    async (_, answer) => {
      const { client } = network({
        "https://give.hopeshelter.org/connector/v1/campaigns": answer,
      });

      expect(
        await client.act("https://give.hopeshelter.org", WRAPPED, {
          method: "GET",
          path: "/campaigns",
        }),
      ).toStrictEqual({ outcome: "unknown_route" });
    },
  );

  test("act passes a contract 404 other than unknown_route to the chat as a refusal", async () => {
    const { client } = network({
      "https://give.hopeshelter.org/connector/v1/campaigns/c1": () =>
        Response.json(
          {
            error: "not_found",
            message: "No campaign has the id c1.",
            fix: "List the campaigns to get its id.",
          },
          { status: 404 },
        ),
    });

    expect(
      await client.act("https://give.hopeshelter.org", WRAPPED, {
        method: "GET",
        path: "/campaigns/c1",
      }),
    ).toStrictEqual({
      outcome: "refused",
      message: "No campaign has the id c1.",
      fix: "List the campaigns to get its id.",
    });
  });

  test("hello follows redirects and answers with the origin that said hello", async () => {
    const { client } = network({
      "https://hopeshelter.org/connector/v1/hello": redirectTo(
        "https://www.hopeshelter.org/connector/v1/hello",
        301,
      ),
      "https://www.hopeshelter.org/connector/v1/hello": redirectTo(
        "https://give.hopeshelter.org/connector/v1/hello",
        302,
      ),
      "https://give.hopeshelter.org/connector/v1/hello": () =>
        Response.json(HELLO),
    });

    expect(await client.hello("https://hopeshelter.org")).toStrictEqual({
      ok: true,
      origin: "https://give.hopeshelter.org",
      release: "1.4.0",
    });
  });

  test("hello gives up after three redirects", async () => {
    const hops = ["a", "b", "c", "d", "e"].map(
      (sub) => `https://${sub}.hopeshelter.org/connector/v1/hello`,
    );
    const { client, sent } = network(
      Object.fromEntries(
        hops.map((hop, index) => [
          hop,
          index === 4
            ? () => Response.json(HELLO)
            : redirectTo(hops[index + 1] ?? ""),
        ]),
      ),
    );

    expect(await client.hello("https://a.hopeshelter.org")).toStrictEqual({
      ok: false,
      problem: "no_answer",
    });
    expect(sent).toHaveLength(4);
  });

  test("hello never sends a request to a host on a private network, a redirect's included", async () => {
    const { client, sent } = network(
      {
        "https://give.hopeshelter.org/connector/v1/hello": redirectTo(
          "https://metadata.internal/connector/v1/hello",
        ),
      },
      ["metadata.internal"],
    );

    expect(await client.hello("https://give.hopeshelter.org")).toStrictEqual({
      ok: false,
      problem: "no_answer",
    });
    expect(sent.map(({ url }) => url)).toStrictEqual([
      "https://give.hopeshelter.org/connector/v1/hello",
    ]);
  });
});

describe("isPublicAddress", () => {
  test.each([
    ["127.0.0.1", 4],
    ["10.1.2.3", 4],
    ["172.31.255.255", 4],
    ["192.168.0.10", 4],
    ["169.254.169.254", 4],
    ["100.64.0.1", 4],
    ["::1", 6],
    ["fd00::1", 6],
    ["fe80::1", 6],
    ["::ffff:127.0.0.1", 6],
  ] as const)("refuses %s", (address, family) => {
    expect(isPublicAddress(address, family)).toBe(false);
  });

  test.each([
    ["76.76.21.21", 4],
    ["172.32.0.1", 4],
    ["2606:4700::6810:84e5", 6],
  ] as const)("allows %s", (address, family) => {
    expect(isPublicAddress(address, family)).toBe(true);
  });
});

describe("publicInternet", () => {
  test("refuses a name that resolves to loopback", async () => {
    expect(await publicInternet.lookup("localhost")).toBe("not_public");
  });
});
