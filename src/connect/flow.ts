import { createHash, randomBytes } from "node:crypto";
import type { AppDeps } from "../app.ts";
import { CONNECT_PATH, ConnectRequestInvalid } from "../auth/index.ts";
import type { PendingConnect } from "../db/index.ts";
import { allowUrl, type DeploymentKey } from "../deployment/index.ts";

/** An attempt needs this long left to send the operator to Allow and back. */
const MIN_WINDOW_MS = 2 * 60 * 1000;
/** How long an abandoned attempt outlives its expiry: a late Allow is still exchanged to revoke its key. */
export const SWEEP_GRACE_MS = 60 * 60 * 1000;

/** The final pages `/connect/result` shows, by its `outcome`. */
export const RESULT_OUTCOMES = [
  "cancelled",
  "cancelled-retry",
  "unconfirmed",
  "expired",
  "failed",
  "deployment-down",
] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

/** Whether a connect attempt over a query can start. */
export type ConnectWindow =
  | { kind: "open"; expiresAt: Date }
  /** the query is the chat app's, but too little or none of its time is left */
  | { kind: "over" }
  /** not a query the chat app's authorize sent */
  | { kind: "none" };

/** What the deployment's redirect back carried. */
export interface ReturnQuery {
  state?: string | undefined;
  code?: string | undefined;
  error?: string | undefined;
  /** the origin of the deployment that sent it back (RFC 9207) */
  iss?: string | undefined;
}

export type Finished =
  | { outcome: "connected"; redirectTo: string }
  | { outcome: Exclude<ResultOutcome, "cancelled-retry"> }
  /** `attempt` is the fresh attempt the result page offers a way back to Allow through */
  | { outcome: "cancelled-retry"; attempt: string };

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * The expiry `oauthQuery` claims, unverified: it only picks which page explains a refusal, never
 * what is allowed.
 */
function claimedExpiry(oauthQuery: string): Date | undefined {
  const exp = new URLSearchParams(oauthQuery).get("exp");
  return exp !== null && /^\d+$/.test(exp)
    ? new Date(Number(exp) * 1000)
    : undefined;
}

/** Whether an attempt expiring at `expiresAt` has time to send the operator to Allow and back. */
export function hasTimeLeft(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() - now.getTime() >= MIN_WINDOW_MS;
}

function hasRunOut(oauthQuery: string, now: Date): boolean {
  const expiry = claimedExpiry(oauthQuery);
  return expiry !== undefined && expiry <= now;
}

/** The connect flow's steps, between the address page and the chat app's callback. */
export function connectFlow({
  attempts,
  auth,
  connections,
  deployments,
  pendingConnects,
  publicUrl,
}: AppDeps) {
  const returnTo = new URL(`${CONNECT_PATH}/return`, publicUrl).href;

  async function window(oauthQuery: string, now: Date): Promise<ConnectWindow> {
    const status = await auth.connectRequestStatus(oauthQuery);
    if (status.ok) {
      return hasTimeLeft(status.expiresAt, now)
        ? { kind: "open", expiresAt: status.expiresAt }
        : { kind: "over" };
    }
    return hasRunOut(oauthQuery, now) ? { kind: "over" } : { kind: "none" };
  }

  /**
   * A new pending attempt for the browser holding `nonce`, and the Allow URL that sends the
   * operator to it.
   */
  async function handOff(
    attempt: Omit<PendingConnect, "codeVerifier"> & { expiresAt: Date },
    nonce: string,
    now: Date,
  ): Promise<{ state: string; allowUrl: string }> {
    const state = attempts.stateFor(nonce);
    const codeVerifier = randomToken();
    await pendingConnects.sweepExpired(now, SWEEP_GRACE_MS);
    await pendingConnects.create({ ...attempt, state, codeVerifier });
    return {
      state,
      allowUrl: allowUrl(attempt.deploymentUrl, {
        returnTo,
        state,
        codeChallenge: s256(codeVerifier),
      }),
    };
  }

  /**
   * Signs the chat app in over `key`'s connection. A failure revokes the key and removes whatever
   * was made with it: no key outlives a connection that never formed.
   */
  async function connect(
    attempt: PendingConnect,
    key: DeploymentKey,
    now: Date,
  ): Promise<Finished> {
    let userId: string | undefined;
    try {
      const signedIn = await auth.connectionSignIn(attempt.oauthQuery);
      userId = signedIn.userId;
      await connections.create({
        userId,
        deploymentUrl: attempt.deploymentUrl,
        release: attempt.release,
        key: key.reveal(),
      });
      return { outcome: "connected", redirectTo: signedIn.redirectTo };
    } catch (error) {
      await deployments.disconnect(attempt.deploymentUrl, key);
      if (userId !== undefined) {
        await auth.deleteConnectionUser(userId).catch(() => {});
      }
      if (!(error instanceof ConnectRequestInvalid)) throw error;
      return {
        outcome: hasRunOut(attempt.oauthQuery, now) ? "expired" : "unconfirmed",
      };
    }
  }

  return {
    window,
    handOff,

    /**
     * Handles the deployment's redirect back, once, in the browser holding `nonce`. First it
     * refuses a return another browser started, or one whose `iss` isn't the deployment the
     * attempt went to, before any exchange: either can steer a code, and the verifier with it, to
     * someone else. Then the copy note's order of checks at the return.
     */
    async finish(
      { state, code, error, iss }: ReturnQuery,
      nonce: string | undefined,
      now: Date,
    ): Promise<Finished> {
      if (
        state === undefined ||
        nonce === undefined ||
        !attempts.isBound(state, nonce)
      ) {
        return { outcome: "unconfirmed" };
      }
      const attempt = await pendingConnects.consume(state, now);
      if (attempt === null || iss !== attempt.deploymentUrl) {
        return { outcome: "unconfirmed" };
      }
      if (attempt.expired) {
        if (error === "access_denied") return { outcome: "cancelled" };
        if (code !== undefined && error === undefined) {
          const late = await deployments.exchange(
            attempt.deploymentUrl,
            code,
            attempt.codeVerifier,
          );
          if (late.ok)
            await deployments.disconnect(attempt.deploymentUrl, late.key);
        }
        return { outcome: "expired" };
      }
      if (error === "access_denied") {
        const open = await window(attempt.oauthQuery, now);
        if (open.kind !== "open") return { outcome: "cancelled" };
        const retry = await handOff(
          {
            oauthQuery: attempt.oauthQuery,
            deploymentUrl: attempt.deploymentUrl,
            release: attempt.release,
            expiresAt: open.expiresAt,
          },
          nonce,
          now,
        );
        return { outcome: "cancelled-retry", attempt: retry.state };
      }
      if (error !== undefined || code === undefined) {
        return { outcome: "unconfirmed" };
      }
      const exchanged = await deployments.exchange(
        attempt.deploymentUrl,
        code,
        attempt.codeVerifier,
      );
      if (exchanged.ok) return connect(attempt, exchanged.key, now);
      switch (exchanged.problem) {
        case "invalid_code":
          return { outcome: "unconfirmed" };
        case "no_answer":
          return { outcome: "deployment-down" };
        case "unexpected":
          return { outcome: "failed" };
      }
    },

    /** The way back to Allow a `cancelled-retry` page offers, while its attempt can still finish. */
    async retryAllowUrl(
      attempt: string,
      now: Date,
    ): Promise<string | undefined> {
      const pending = await pendingConnects.peek(
        attempt,
        new Date(now.getTime() + MIN_WINDOW_MS),
      );
      return pending === null
        ? undefined
        : allowUrl(pending.deploymentUrl, {
            returnTo,
            state: attempt,
            codeChallenge: s256(pending.codeVerifier),
          });
    },
  };
}
