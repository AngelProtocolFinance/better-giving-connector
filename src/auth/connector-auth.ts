import {
  createResourceServerChallenge,
  verifyOAuthQueryParams,
} from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { parseSetCookieHeader } from "better-auth/cookies";
import {
  getDpopJktFromPayload,
  verifyJwsAccessToken,
} from "better-auth/oauth2";
import {
  AUTH_BASE_PATH,
  type AuthDeps,
  authOptions,
  MCP_PATH,
} from "./options.ts";
import { sweepQueries } from "./sweep.ts";

/** The authorization can't be resumed: its query isn't one `/authorize` signed, it expired, or the client can no longer take a code. */
export class ConnectRequestInvalid extends Error {
  override name = "ConnectRequestInvalid";
  constructor() {
    super(
      "the authorization request is invalid or expired; start again from the chat app",
    );
  }
}

/** Whether a connect query can still be resumed, and until when. */
export type ConnectRequestStatus =
  | { ok: true; expiresAt: Date }
  | { ok: false };

/** What the `/mcp` guard decided about a request. */
export type McpAccess =
  | { ok: true; userId: string }
  /** answer 401 with `wwwAuthenticate` as the `WWW-Authenticate` header */
  | { ok: false; wwwAuthenticate: string };

export interface SweepOptions {
  /** defaults to the current time */
  now?: Date;
  /** at most this many connection-users, and this many clients, per call */
  limit?: number;
  /**
   * Revokes the connection's deployment key and deletes its row; called once
   * per connection-user before its better-auth data goes, so a throw keeps
   * the user for the next sweep to retry. Throw only for a failure worth
   * retrying: the oldest users come first, so ones that always throw hold
   * the batch. A user whose deletion failed comes back, so a user with no
   * row is already done.
   */
  disconnect: (userId: string) => Promise<void>;
}

export interface SweepResult {
  /** connection-users disconnected and deleted */
  disconnected: number;
  /** connection-users kept because `disconnect` threw; its error is dropped */
  failed: number;
  /** registered clients over a day old that no connection completed through */
  clientsDeleted: number;
  /**
   * A batch was full and made progress: another call now may sweep more. A
   * full batch that only failed is false, so a loop on it ends.
   */
  more: boolean;
}

const DEFAULT_SWEEP_LIMIT = 50;

const BEARER = /^Bearer +(\S+)$/i;

/** The signing keys couldn't be read: the server's failure, not the token's. */
class SigningKeysUnavailable extends Error {
  override name = "SigningKeysUnavailable";
}

/** The OAuth authorization server Claude and ChatGPT sign in through, over the app's database. */
export function createConnectorAuth(deps: AuthDeps) {
  const auth = betterAuth(authOptions(deps));
  const issuer = new URL(deps.publicUrl).origin;
  const resource = `${issuer}${MCP_PATH}`;
  const jwksCacheKey = {};

  const challengeError = createResourceServerChallenge(
    new APIError("UNAUTHORIZED"),
    resource,
  );
  const challenge =
    challengeError &&
    new Headers(challengeError.headers).get("WWW-Authenticate");
  if (!challenge) throw new Error("no bearer challenge for the /mcp resource");
  const refusal: McpAccess = { ok: false, wwwAuthenticate: challenge };
  const swept = sweepQueries(deps.db);

  async function deleteConnectionUser(userId: string): Promise<void> {
    await auth.api.deleteConnectionUser({ body: { userId } });
  }

  return {
    /** Serves `/api/auth/*` and the `/.well-known/*` discovery documents. */
    handler: (request: Request): Promise<Response> => auth.handler(request),

    /**
     * Whether `oauthQuery`, the query `/authorize` sent to the connect flow, can
     * still be resumed, and until when. Creates nothing: check it before
     * sending the operator to the deployment, since `connectionSignIn` refuses
     * the query once `expiresAt` has passed.
     */
    async connectRequestStatus(
      oauthQuery: string,
    ): Promise<ConnectRequestStatus> {
      if (!(await verifyOAuthQueryParams(oauthQuery, deps.secret))) {
        return { ok: false };
      }
      const exp = Number(new URLSearchParams(oauthQuery).get("exp"));
      return { ok: true, expiresAt: new Date(exp * 1000) };
    },

    /**
     * Creates the connection-user and resumes the authorization the chat app
     * started: `oauthQuery` is the query `/authorize` sent to the connect flow,
     * as received. Call it only once the deployment's Allow screen has
     * answered: it records consent on the user's behalf. Send the browser to
     * `redirectTo`, the chat app's callback with its code; no session cookie
     * goes to the browser. Throws `ConnectRequestInvalid`, leaving no user,
     * when the authorization can't finish. Should storing the connection fail
     * after this returns, `deleteConnectionUser(userId)` voids the code.
     */
    async connectionSignIn(
      oauthQuery: string,
    ): Promise<{ userId: string; redirectTo: string }> {
      const clientId = new URLSearchParams(oauthQuery).get("client_id");
      if (
        clientId === null ||
        !(await verifyOAuthQueryParams(oauthQuery, deps.secret))
      ) {
        throw new ConnectRequestInvalid();
      }
      const created = await auth.api.createConnectionSession({
        returnHeaders: true,
      });
      const { userId } = created.response;
      try {
        const cookies = parseSetCookieHeader(
          created.headers.get("set-cookie") ?? "",
        );
        const cookie = [...cookies]
          .map(([name, { value }]) => `${name}=${value}`)
          .join("; ");
        const headers = new Headers({ cookie });
        const resumed = await auth.api.oauth2Consent({
          body: { accept: true, oauth_query: oauthQuery },
          headers,
          asResponse: false,
          // authorize reads the request it resumes, which a server call lacks
          request: new Request(`${issuer}${AUTH_BASE_PATH}/oauth2/consent`, {
            method: "POST",
            headers,
          }),
        });
        if (!new URL(resumed.url).searchParams.has("code")) {
          throw new ConnectRequestInvalid();
        }
        await swept.markClientConnected(clientId);
        return { userId, redirectTo: resumed.url };
      } catch (error) {
        try {
          await deleteConnectionUser(userId);
        } catch {
          // the user is orphaned either way; the caller needs the first cause
        }
        throw error instanceof APIError ? new ConnectRequestInvalid() : error;
      }
    },

    /**
     * The connection-user a request to `/mcp` acts as: its bearer token must be
     * one this server signed for the `/mcp` resource, unexpired, held by a user
     * that still exists.
     */
    async verifyMcpRequest(request: Request): Promise<McpAccess> {
      const { internalAdapter } = await auth.$context;
      const token = BEARER.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (token === undefined) return refusal;
      let subject: unknown;
      try {
        const claims = await verifyJwsAccessToken(token, {
          jwksFetch: () =>
            auth.api.getJwks().catch((cause: unknown) => {
              throw new SigningKeysUnavailable("reading the JWKS failed", {
                cause,
              });
            }),
          jwksCacheKey,
          verifyOptions: { issuer, audience: resource },
        });
        // a DPoP-bound token proves nothing without its proof, which this guard doesn't check
        if (getDpopJktFromPayload(claims)) return refusal;
        subject = claims.sub;
      } catch (error) {
        // a 401 sends the chat app to refresh and re-authorize: only for a bad token
        if (error instanceof SigningKeysUnavailable) throw error;
        return refusal;
      }
      if (typeof subject !== "string") return refusal;
      const user = await internalAdapter.findUserById(subject);
      return user === null ? refusal : { ok: true, userId: user.id };
    },

    /**
     * Reconnect: deletes the connection-user and its sessions, tokens and
     * consents, so every token the chat app holds stops working.
     */
    deleteConnectionUser,

    async sweep({
      now = new Date(),
      limit = DEFAULT_SWEEP_LIMIT,
      disconnect,
    }: SweepOptions): Promise<SweepResult> {
      const clientsDeleted = await swept.deleteUnusedClients(now, limit);
      const stale = await swept.staleConnectionUsers(now, limit);
      let disconnected = 0;
      for (const userId of stale) {
        try {
          await disconnect(userId);
        } catch {
          continue;
        }
        await deleteConnectionUser(userId);
        disconnected++;
      }
      return {
        disconnected,
        failed: stale.length - disconnected,
        clientsDeleted,
        more:
          clientsDeleted === limit ||
          (stale.length === limit && disconnected > 0),
      };
    },
  };
}

export type ConnectorAuth = ReturnType<typeof createConnectorAuth>;
