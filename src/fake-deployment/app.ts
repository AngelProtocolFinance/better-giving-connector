import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { html } from "hono/html";

/**
 * A Better Giving deployment's Handshake (docs/connector-v1.md), with no sign-in and no data behind
 * it: for tests and local walks of the connect flow.
 */
export interface FakeDeploymentOptions {
  /** the one `return_to` its Allow page accepts */
  returnTo: string;
  /** hello's body; null serves no hello, as a release from before `/connector/v1` */
  hello?: {
    revision: number;
    release: string | null;
    org_name: string;
  } | null;
  /** exchange answers this status instead of redeeming the code */
  exchangeFailure?: number;
}

const CODE_LIFETIME_MS = 5 * 60 * 1000;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function connectorKey(): string {
  // a byte mod 62 favours the first 8 symbols slightly: irrelevant to a fake
  return `bgc_${[...randomBytes(43)].map((byte) => BASE62[byte % 62]).join("")}`;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function refusal(error: string, message: string) {
  return { error, message, fix: "Start again from the chat app." };
}

export function createFakeDeployment({
  returnTo,
  hello = { revision: 1, release: "1.4.0", org_name: "Hope Shelter" },
  exchangeFailure,
}: FakeDeploymentOptions) {
  const codes = new Map<
    string,
    { challenge: string; key: string; expiresAt: number }
  >();
  /** every key Allow minted, and whether it's been revoked */
  const keys = new Map<string, { revoked: boolean }>();

  const app = new Hono()
    .use(async (c, next) => {
      await next();
      c.header("cache-control", "no-store");
    })
    .get("/connector/v1/hello", (c) =>
      hello === null
        ? c.json(refusal("unknown_route", "No such route."), 404)
        : c.json({ service: "better-giving", contract: "v1", ...hello }, 200),
    )
    .get("/integrations/v1/gifts", (c) =>
      c.json(refusal("missing_key", "Send an API key."), 401),
    )
    .get("/connector/allow", (c) => {
      if (c.req.query("return_to") !== returnTo) {
        return c.text("return_to is not the connector's", 400);
      }
      // action="" posts back to this URL, its query included
      return c.html(
        html`<!doctype html><title>Allow · Fake Better Giving</title>
<h1>Connect ${hello?.org_name ?? "this deployment"} to the chat app?</h1>
<form method="post" action=""><button name="decision" value="allow">Allow</button>
<button name="decision" value="cancel">Cancel</button></form>`,
      );
    })
    .post("/connector/allow", async (c) => {
      const state = c.req.query("state");
      const challenge = c.req.query("code_challenge");
      if (
        c.req.query("return_to") !== returnTo ||
        state === undefined ||
        challenge === undefined ||
        c.req.query("code_challenge_method") !== "S256"
      ) {
        return c.text("not an allow request", 400);
      }
      const back = new URL(returnTo);
      const { decision } = await c.req.parseBody();
      if (decision === "allow") {
        const key = connectorKey();
        const code = randomBytes(32).toString("base64url");
        keys.set(key, { revoked: false });
        codes.set(code, {
          challenge,
          key,
          expiresAt: Date.now() + CODE_LIFETIME_MS,
        });
        back.searchParams.set("code", code);
      } else {
        back.searchParams.set("error", "access_denied");
      }
      back.searchParams.set("state", state);
      return c.redirect(back.href, 303);
    })
    .post("/connector/v1/exchange", async (c) => {
      if (exchangeFailure !== undefined) {
        return c.json(
          refusal("unavailable", "Try again later."),
          exchangeFailure as 500,
        );
      }
      const body = await c.req
        .json<{ code?: unknown; code_verifier?: unknown }>()
        .catch(() => ({}) as { code?: unknown; code_verifier?: unknown });
      const issued =
        typeof body.code === "string" ? codes.get(body.code) : undefined;
      if (typeof body.code === "string") codes.delete(body.code);
      if (
        issued === undefined ||
        issued.expiresAt <= Date.now() ||
        typeof body.code_verifier !== "string" ||
        s256(body.code_verifier) !== issued.challenge
      ) {
        return c.json(
          refusal("invalid_code", "The code is used, expired or unknown."),
          400,
        );
      }
      return c.json(
        { key: issued.key, org_name: hello?.org_name ?? "Fake" },
        200,
      );
    })
    .post("/connector/v1/disconnect", (c) => {
      const key = /^Bearer (\S+)$/.exec(
        c.req.header("authorization") ?? "",
      )?.[1];
      const minted = key === undefined ? undefined : keys.get(key);
      if (minted === undefined || minted.revoked) {
        return c.json(refusal("unknown_key", "The key is unknown."), 401);
      }
      minted.revoked = true;
      return c.body(null, 204);
    });

  return {
    app,
    /** the keys Allow minted, oldest first */
    mintedKeys: () => [...keys.keys()],
    revokedKeys: () =>
      [...keys].filter(([, { revoked }]) => revoked).map(([key]) => key),
  };
}

export type FakeDeployment = ReturnType<typeof createFakeDeployment>;
