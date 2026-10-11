import type { Client } from "@libsql/client";
import { expect } from "vitest";
import { createApp } from "./app.ts";
import { createDb, migrate } from "./db/index.ts";
import { appDeps } from "./deps.ts";
import { createLogger } from "./log.ts";

export const PUBLIC_URL = "https://connect.example.org";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** The app over a fresh migrated in-memory database, wired as the entries wire it, its log lines captured. */
export async function startApp() {
  const db: Client = createDb({ url: ":memory:" });
  await migrate(db);
  const lines: string[] = [];
  const deps = appDeps(
    {
      PUBLIC_URL,
      TURSO_DATABASE_URL: ":memory:",
      BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
      CONNECTION_KEY_SECRET: "Lr/Z0xJQHZpmF5zhgg5XymNMJUGxag0TOR8KYd2PPJc=",
    },
    db,
    createLogger((line) => lines.push(line)),
  );
  // better-auth writes its seed rows as it starts, unawaited: a test closing
  // the database first would fail that write as an unhandled rejection
  await deps.auth.handler(
    new Request(`${PUBLIC_URL}/.well-known/oauth-authorization-server`),
  );
  const app = createApp(deps);
  /** `path` on the app, at the public origin the issuer names. */
  const request = (path: string, init?: RequestInit) =>
    app.request(`${PUBLIC_URL}${path}`, init);
  return { db, app, lines, request, ...deps };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(new Uint8Array(bytes)).toString("base64url");
}

/**
 * The whole sign-in a chat app runs, through the app: register, authorize,
 * the connect flow's `connectionSignIn`, then the code exchange.
 */
export async function signIn(t: TestApp) {
  const registered = await t.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test client",
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as {
    client_id: string;
  };

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const authorized = await t.request(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      scope: "offline_access",
      state: "claude-state-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${PUBLIC_URL}/mcp`,
    })}`,
  );
  const connectQuery = new URL(authorized.headers.get("location") ?? "").search;
  const { userId, redirectTo } = await t.auth.connectionSignIn(
    connectQuery.slice(1),
  );

  const exchanged = await t.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: new URL(redirectTo).searchParams.get("code") ?? "",
      code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK,
      resource: `${PUBLIC_URL}/mcp`,
    }),
  });
  expect(exchanged.status).toBe(200);
  const tokens = (await exchanged.json()) as Record<string, string>;
  return {
    userId,
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token ?? "",
  };
}
