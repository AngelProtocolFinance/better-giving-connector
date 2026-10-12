import { z } from "zod";
import { DeploymentKey } from "./key.ts";
import type { DeploymentNetwork } from "./network.ts";

/** Each call's whole budget, redirects and the older-release probe included. */
const CALL_TIMEOUT_MS = 8000;
const MAX_HELLO_REDIRECTS = 3;
/** Far above any Handshake answer; a body past it is not a deployment's. */
const MAX_HANDSHAKE_BODY_BYTES = 64 * 1024;
/** Room for a campaign carrying two whole page documents, or the page catalog's JSON Schema. */
const MAX_ACTION_BODY_BYTES = 1024 * 1024;

const HELLO_PATH = "/connector/v1/hello";

const Hello = z.object({
  service: z.literal("better-giving"),
  contract: z.literal("v1"),
  revision: z.int(),
  release: z.string().nullable(),
});

const Exchanged = z.object({ key: z.string().min(1) });
const Refusal = z.object({ error: z.string() });
const ActionRefusal = z.object({
  error: z.string(),
  message: z.string(),
  fix: z.string(),
});

/** Why a deployment couldn't be used, in the address page's terms. */
export type HelloProblem =
  | "no_such_host"
  | "no_answer"
  | "not_better_giving"
  | "outdated";

export type HelloAnswer =
  | { ok: true; origin: string; release: string | null }
  | { ok: false; problem: HelloProblem };

export type ExchangeAnswer =
  | { ok: true; key: DeploymentKey }
  | { ok: false; problem: "invalid_code" | "no_answer" | "unexpected" };

/** One `/connector/v1` action; `path` is below the base, any id in it already encoded. */
export interface ActionRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: `/${string}`;
  body?: Record<string, unknown>;
}

/** What a deployment answered an action, in the terms of docs/connector-v1.md → Codes the connector acts on. */
export type ActionAnswer =
  | { outcome: "ok"; body: Record<string, unknown> }
  /** a 204 */
  | { outcome: "done" }
  /** `401`: the key is unknown, revoked or missing, and stays refused */
  | { outcome: "key_refused" }
  /** `404 unknown_route`, or a 404 that isn't the contract's: the deployment's release lacks the action, or `/connector/v1` */
  | { outcome: "unknown_route" }
  | { outcome: "stale" }
  /** `429`, with `retry-after` when it gives seconds */
  | { outcome: "rate_limited"; retryAfterSeconds: number | null }
  /** any other 4xx, its sentences for the chat as the deployment wrote them */
  | { outcome: "refused"; message: string; fix: string }
  /** a 5xx, a redirect, a timeout, no connection, or an answer that isn't the contract's */
  | { outcome: "no_answer" };

const JsonObject = z.record(z.string(), z.unknown());
const KEY_REFUSALS = new Set(["unknown_key", "revoked_key", "missing_key"]);

type Sent =
  | { ok: true; response: Response }
  | { ok: false; problem: "no_such_host" | "no_answer" };

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/**
 * `response`'s body as JSON, or undefined when it isn't JSON, runs past `maxBytes` or fails
 * mid-read.
 */
async function readJson(
  response: Response,
  maxBytes = MAX_HANDSHAKE_BODY_BYTES,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The Allow screen's URL, for the operator's browser (docs/connector-v1.md → Allow). */
export function allowUrl(
  origin: string,
  params: { returnTo: string; state: string; codeChallenge: string },
): string {
  const url = new URL("/connector/allow", origin);
  url.search = new URLSearchParams({
    return_to: params.returnTo,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.href;
}

/** A deployment's `/connector/v1`, reached over `network`. */
export function deploymentClient(network: DeploymentNetwork) {
  /**
   * One request, never following a redirect, sent only once `url`'s host resolves to public
   * addresses alone. A failure to connect, a timeout included, is `no_answer`.
   */
  async function send(
    url: URL,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Sent> {
    if (url.protocol !== "https:") return { ok: false, problem: "no_answer" };
    try {
      const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
      const reach = await Promise.race([network.lookup(host), aborted(signal)]);
      if (reach !== "public") {
        return {
          ok: false,
          problem: reach === "no_such_host" ? "no_such_host" : "no_answer",
        };
      }
      const response = await network.fetch(url.href, {
        ...init,
        redirect: "manual",
        signal,
      });
      return { ok: true, response };
    } catch {
      return { ok: false, problem: "no_answer" };
    }
  }

  /** An older release has no hello, but its `/integrations/v1` key gate answers this way. */
  async function isOlderRelease(
    origin: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const sent = await send(
      new URL("/integrations/v1/gifts", origin),
      { headers: { accept: "application/json" } },
      signal,
    );
    if (!sent.ok || sent.response.status !== 401) return false;
    const refusal = Refusal.safeParse(await readJson(sent.response));
    return refusal.success && refusal.data.error === "missing_key";
  }

  return {
    /**
     * Whether `origin` serves a Better Giving deployment the connector can use; following up to
     * three redirects, the origin it answered from.
     */
    async hello(origin: string): Promise<HelloAnswer> {
      const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
      let url = new URL(HELLO_PATH, origin);
      for (let redirects = 0; ; redirects++) {
        const sent = await send(
          url,
          { headers: { accept: "application/json" } },
          signal,
        );
        if (!sent.ok) return sent;
        const { response } = sent;
        if (isRedirect(response.status)) {
          await response.body?.cancel();
          const next = response.headers.get("location");
          if (next === null || redirects === MAX_HELLO_REDIRECTS) {
            return { ok: false, problem: "no_answer" };
          }
          url = new URL(next, url);
          continue;
        }
        if (response.status >= 500) {
          await response.body?.cancel();
          return { ok: false, problem: "no_answer" };
        }
        if (response.status === 404) {
          await response.body?.cancel();
          return {
            ok: false,
            problem: (await isOlderRelease(url.origin, signal))
              ? "outdated"
              : "not_better_giving",
          };
        }
        if (response.status !== 200 || url.pathname !== HELLO_PATH) {
          await response.body?.cancel();
          return { ok: false, problem: "not_better_giving" };
        }
        const hello = Hello.safeParse(await readJson(response));
        if (!hello.success) return { ok: false, problem: "not_better_giving" };
        if (hello.data.revision < 1) return { ok: false, problem: "outdated" };
        return { ok: true, origin: url.origin, release: hello.data.release };
      }
    },

    /** Redeems the code Allow sent back for the deployment's key. */
    async exchange(
      origin: string,
      code: string,
      codeVerifier: string,
    ): Promise<ExchangeAnswer> {
      const sent = await send(
        new URL("/connector/v1/exchange", origin),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ code, code_verifier: codeVerifier }),
        },
        AbortSignal.timeout(CALL_TIMEOUT_MS),
      );
      if (!sent.ok) return { ok: false, problem: "no_answer" };
      const { response } = sent;
      if (response.status >= 500) {
        await response.body?.cancel();
        return { ok: false, problem: "no_answer" };
      }
      const body = await readJson(response);
      if (response.status === 200) {
        const exchanged = Exchanged.safeParse(body);
        if (exchanged.success) {
          return { ok: true, key: new DeploymentKey(exchanged.data.key) };
        }
      }
      const refusal = Refusal.safeParse(body);
      return {
        ok: false,
        problem:
          response.status === 400 &&
          refusal.success &&
          refusal.data.error === "invalid_code"
            ? "invalid_code"
            : "unexpected",
      };
    },

    /** `request` sent to `origin`'s `/connector/v1` with `key`, never to a redirect's target. Never throws. */
    async act(
      origin: string,
      key: DeploymentKey,
      { method, path, body }: ActionRequest,
    ): Promise<ActionAnswer> {
      const sent = await send(
        new URL(`/connector/v1${path}`, origin),
        {
          method,
          headers: {
            authorization: `Bearer ${key.reveal()}`,
            accept: "application/json",
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        AbortSignal.timeout(CALL_TIMEOUT_MS),
      );
      if (!sent.ok) return { outcome: "no_answer" };
      const { response } = sent;
      if (response.status === 204) {
        await response.body?.cancel();
        return { outcome: "done" };
      }
      if (response.status >= 200 && response.status < 300) {
        const answered = JsonObject.safeParse(
          await readJson(response, MAX_ACTION_BODY_BYTES),
        );
        return answered.success
          ? { outcome: "ok", body: answered.data }
          : { outcome: "no_answer" };
      }
      if (response.status < 400 || response.status >= 500) {
        await response.body?.cancel();
        return { outcome: "no_answer" };
      }
      if (response.status === 429) {
        await response.body?.cancel();
        const retryAfter = response.headers.get("retry-after") ?? "";
        return {
          outcome: "rate_limited",
          retryAfterSeconds: /^\d{1,6}$/.test(retryAfter)
            ? Number(retryAfter)
            : null,
        };
      }
      const refusal = ActionRefusal.safeParse(await readJson(response));
      if (!refusal.success) {
        return {
          outcome: response.status === 404 ? "unknown_route" : "no_answer",
        };
      }
      const { error } = refusal.data;
      if (response.status === 401 && KEY_REFUSALS.has(error)) {
        return { outcome: "key_refused" };
      }
      if (response.status === 404 && error === "unknown_route") {
        return { outcome: "unknown_route" };
      }
      if (response.status === 409 && error === "stale") {
        return { outcome: "stale" };
      }
      const { message, fix } = refusal.data;
      return { outcome: "refused", message, fix };
    },

    /** Revokes `key`; true once the deployment confirms. Never throws. */
    async disconnect(origin: string, key: DeploymentKey): Promise<boolean> {
      const sent = await send(
        new URL("/connector/v1/disconnect", origin),
        {
          method: "POST",
          headers: { authorization: `Bearer ${key.reveal()}` },
        },
        AbortSignal.timeout(CALL_TIMEOUT_MS),
      );
      if (!sent.ok) return false;
      await sent.response.body?.cancel();
      return sent.response.status === 204;
    },
  };
}

export type DeploymentClient = ReturnType<typeof deploymentClient>;
