import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb, migrate } from "../db/index.ts";
import {
  type ConnectorAuth,
  ConnectRequestInvalid,
  createConnectorAuth,
} from "./index.ts";

const PUBLIC_URL = "https://connect.example.org";
const SECRET = "test-better-auth-secret-0123456789abcdef";

let db: Client;
let auth: ConnectorAuth;

beforeEach(async () => {
  db = createDb({ url: ":memory:" });
  await migrate(db);
  auth = createConnectorAuth({ db, publicUrl: PUBLIC_URL, secret: SECRET });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.close();
});

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_CALLBACK =
  "https://chatgpt.com/connector_platform_oauth_redirect";
const LOOPBACK_CALLBACK = "http://127.0.0.1:33418/callback";

function register(redirectUris: string[]): Promise<Response> {
  return auth.handler(
    new Request(`${PUBLIC_URL}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "test client",
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
}

async function registeredClientId(redirectUri = CLAUDE_CALLBACK) {
  const res = await register([redirectUri]);
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(new Uint8Array(bytes)).toString("base64url");
}

async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

/**
 * `/authorize` for `clientId`, as Claude sends it, with no session; `changes`
 * sets a parameter, or drops it when `null`.
 */
function authorize(
  clientId: string,
  challenge: string,
  changes: Record<string, string | null> = {},
): Promise<Response> {
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    scope: "offline_access",
    state: "claude-state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${PUBLIC_URL}/mcp`,
    ...changes,
  };
  const query = new URLSearchParams(
    Object.entries(params).flatMap(([name, value]): [string, string][] =>
      value === null ? [] : [[name, value]],
    ),
  );
  return auth.handler(
    new Request(`${PUBLIC_URL}/api/auth/oauth2/authorize?${query}`),
  );
}

function tokenRequest(fields: Record<string, string>): Promise<Response> {
  return auth.handler(
    new Request(`${PUBLIC_URL}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
  );
}

/** Register, authorize, connect and resume: the code Claude's callback receives. */
async function connectedCode() {
  const clientId = await registeredClientId();
  const { verifier, challenge } = await pkcePair();
  const authorized = await authorize(clientId, challenge);
  const connectUrl = new URL(authorized.headers.get("location") ?? "");
  const { userId, redirectTo } = await auth.connectionSignIn(
    connectUrl.search.slice(1),
  );
  const code = new URL(redirectTo).searchParams.get("code") ?? "";
  return { clientId, verifier, userId, code };
}

function exchangeCode(
  { clientId, code }: { clientId: string; code: string },
  verifier?: string,
): Promise<Response> {
  return tokenRequest({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: CLAUDE_CALLBACK,
    resource: `${PUBLIC_URL}/mcp`,
    ...(verifier === undefined ? {} : { code_verifier: verifier }),
  });
}

async function connectedTokens() {
  const connected = await connectedCode();
  const res = await exchangeCode(connected, connected.verifier);
  expect(res.status).toBe(200);
  const tokens = (await res.json()) as Record<string, string>;
  return { ...connected, tokens };
}

function refresh(clientId: string, refreshToken: string): Promise<Response> {
  return tokenRequest({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    resource: `${PUBLIC_URL}/mcp`,
  });
}

function mcpRequest(accessToken?: string): Request {
  return new Request(`${PUBLIC_URL}/mcp`, {
    method: "POST",
    headers:
      accessToken === undefined
        ? {}
        : { authorization: `Bearer ${accessToken}` },
  });
}

const REFUSAL = {
  ok: false,
  wwwAuthenticate: `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
};

async function getJson(path: string): Promise<Record<string, unknown>> {
  const res = await auth.handler(new Request(`${PUBLIC_URL}${path}`));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("discovery", () => {
  test("authorization server metadata names PUBLIC_URL as the issuer", async () => {
    const metadata = await getJson("/.well-known/oauth-authorization-server");

    expect(metadata.issuer).toBe(PUBLIC_URL);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.registration_endpoint).toBe(
      `${PUBLIC_URL}/api/auth/oauth2/register`,
    );
    // Claude asks for a refresh token only when offline_access is listed
    expect(metadata.scopes_supported).toContain("offline_access");
    // ChatGPT uses its stable callback only for an issuer that returns `iss`
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
  });

  test("protected resource metadata names the /mcp resource and its issuer", async () => {
    const metadata = await getJson("/.well-known/oauth-protected-resource/mcp");

    expect(metadata.resource).toBe(`${PUBLIC_URL}/mcp`);
    expect(metadata.authorization_servers).toEqual([PUBLIC_URL]);
  });
});

describe("dynamic client registration", () => {
  test.each([
    ["Claude", CLAUDE_CALLBACK],
    ["ChatGPT", CHATGPT_CALLBACK],
    ["ChatGPT per-connection", "https://chatgpt.com/connector/oauth/cb_Z9x-1"],
    ["loopback IP", LOOPBACK_CALLBACK],
    ["loopback localhost", "http://localhost:6274/oauth/callback"],
  ])("registers a %s callback", async (_name, uri) => {
    const res = await register([uri]);

    expect(res.status).toBe(201);
    const client = (await res.json()) as Record<string, unknown>;
    expect(client.redirect_uris).toEqual([uri]);
    expect(typeof client.client_id).toBe("string");
  });

  test.each([
    ["an unknown host", "https://evil.example/cb"],
    ["a lookalike Claude path", "https://claude.ai/api/mcp/auth_callback/evil"],
    ["https loopback", "https://127.0.0.1:33418/callback"],
  ])("refuses %s", async (_name, uri) => {
    const res = await register([CLAUDE_CALLBACK, uri]);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });
});

describe("authorization code flow", () => {
  test("authorize without a session sends the browser to the connect flow", async () => {
    const clientId = await registeredClientId();
    const { challenge } = await pkcePair();

    const res = await authorize(clientId, challenge);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      `${PUBLIC_URL}/connect`,
    );
    expect(location.searchParams.get("client_id")).toBe(clientId);
    expect(location.searchParams.get("sig")).toBeTruthy();
  });

  test("connecting resumes the authorization at the client's callback", async () => {
    const clientId = await registeredClientId();
    const { challenge } = await pkcePair();
    const authorized = await authorize(clientId, challenge);
    const query = new URL(authorized.headers.get("location") ?? "").search;

    const { redirectTo } = await auth.connectionSignIn(query.slice(1));

    const callback = new URL(redirectTo);
    expect(`${callback.origin}${callback.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(callback.searchParams.get("state")).toBe("claude-state-1");
    expect(callback.searchParams.get("iss")).toBe(PUBLIC_URL);
    expect(callback.searchParams.get("code")).toBeTruthy();
  });

  test("a failed cleanup doesn't hide why the authorization couldn't finish", async () => {
    const clientId = await registeredClientId();
    const { challenge } = await pkcePair();
    const authorized = await authorize(clientId, challenge);
    const query = new URL(authorized.headers.get("location") ?? "").search;
    await db.execute({
      sql: 'UPDATE "oauthClient" SET "disabled" = 1 WHERE "clientId" = ?',
      args: [clientId],
    });
    await db.execute(
      `CREATE TRIGGER keep_users BEFORE DELETE ON "user" BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END`,
    );

    await expect(auth.connectionSignIn(query.slice(1))).rejects.toThrow(
      ConnectRequestInvalid,
    );
  });

  test("a client asking for a consent prompt still gets its code from the connect flow", async () => {
    const clientId = await registeredClientId();
    const { challenge } = await pkcePair();
    const authorized = await authorize(clientId, challenge, {
      prompt: "consent",
    });
    const query = new URL(authorized.headers.get("location") ?? "").search;

    const { redirectTo } = await auth.connectionSignIn(query.slice(1));

    expect(new URL(redirectTo).searchParams.get("code")).toBeTruthy();
  });

  test("the code and its verifier buy a token the /mcp guard accepts as that user", async () => {
    const connected = await connectedCode();

    const res = await exchangeCode(connected, connected.verifier);

    expect(res.status).toBe(200);
    const tokens = (await res.json()) as Record<string, string>;
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.refresh_token).toBeTruthy();
    expect(
      await auth.verifyMcpRequest(mcpRequest(tokens.access_token)),
    ).toEqual({ ok: true, userId: connected.userId });
  });

  test("a client that names no resource still gets a token the /mcp guard accepts", async () => {
    const clientId = await registeredClientId();
    const { verifier, challenge } = await pkcePair();
    const authorized = await authorize(clientId, challenge, { resource: null });
    const query = new URL(authorized.headers.get("location") ?? "").search;
    const { userId, redirectTo } = await auth.connectionSignIn(query.slice(1));
    const code = new URL(redirectTo).searchParams.get("code") ?? "";

    const res = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
    });

    expect(res.status).toBe(200);
    const tokens = (await res.json()) as Record<string, string>;
    expect(
      await auth.verifyMcpRequest(mcpRequest(tokens.access_token)),
    ).toEqual({ ok: true, userId });
  });

  test("authorize naming a resource other than /mcp is refused before the connect flow", async () => {
    const clientId = await registeredClientId();
    const { challenge } = await pkcePair();

    const res = await authorize(clientId, challenge, {
      resource: "https://api.example.org/",
    });

    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(location.searchParams.get("error")).toBe("invalid_target");
    expect(location.searchParams.get("state")).toBe("claude-state-1");
  });

  test("the code without its PKCE verifier is refused", async () => {
    const connected = await connectedCode();

    const res = await exchangeCode(connected);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  test("a tampered connect query is refused before any user is created", async () => {
    const clientId = await registeredClientId();
    const { challenge } = await pkcePair();
    const authorized = await authorize(clientId, challenge);
    const query = new URL(authorized.headers.get("location") ?? "")
      .searchParams;
    query.set("redirect_uri", LOOPBACK_CALLBACK);

    await expect(auth.connectionSignIn(query.toString())).rejects.toThrow(
      ConnectRequestInvalid,
    );
    const users = await db.execute('SELECT count(*) AS n FROM "user"');
    expect(users.rows[0]?.n).toBe(0);
  });
  test("an authorization that can no longer finish leaves no user behind", async () => {
    const clientId = await registeredClientId();
    const { challenge } = await pkcePair();
    const authorized = await authorize(clientId, challenge);
    const query = new URL(authorized.headers.get("location") ?? "").search;
    await db.execute({
      sql: 'UPDATE "oauthClient" SET "disabled" = 1 WHERE "clientId" = ?',
      args: [clientId],
    });

    await expect(auth.connectionSignIn(query.slice(1))).rejects.toThrow(
      ConnectRequestInvalid,
    );
    const users = await db.execute('SELECT count(*) AS n FROM "user"');
    expect(users.rows[0]?.n).toBe(0);
  });
});

describe("connect request status", () => {
  async function connectQuery() {
    const clientId = await registeredClientId();
    const { challenge } = await pkcePair();
    const authorized = await authorize(clientId, challenge);
    return new URL(authorized.headers.get("location") ?? "").searchParams;
  }

  test("a query /authorize signed is open until its exp", async () => {
    const query = await connectQuery();

    expect(await auth.connectRequestStatus(query.toString())).toEqual({
      ok: true,
      expiresAt: new Date(Number(query.get("exp")) * 1000),
    });
    expect(Number(query.get("exp")) * 1000 - Date.now()).toBeGreaterThan(
      9 * 60_000,
    );
  });

  test("a tampered query is not open", async () => {
    const query = await connectQuery();
    query.set("state", "someone-else");

    expect(await auth.connectRequestStatus(query.toString())).toEqual({
      ok: false,
    });
  });

  test("a query past its exp is not open, and nothing was created checking it", async () => {
    const query = await connectQuery();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60_000 });

    expect(await auth.connectRequestStatus(query.toString())).toEqual({
      ok: false,
    });
    const users = await db.execute('SELECT count(*) AS n FROM "user"');
    expect(users.rows[0]?.n).toBe(0);
  });
});

describe("the /mcp guard", () => {
  test("refuses a request with no bearer token, pointing at the resource metadata", async () => {
    expect(await auth.verifyMcpRequest(mcpRequest())).toEqual(REFUSAL);
  });

  test("a database it can't read is an error, not a refusal that would send the chat app to re-authorize", async () => {
    const { tokens } = await connectedTokens();
    db.close();

    await expect(
      auth.verifyMcpRequest(mcpRequest(tokens.access_token)),
    ).rejects.toThrow();
  });

  test("refuses a token it did not sign", async () => {
    expect(
      await auth.verifyMcpRequest(mcpRequest("eyJhbGciOiJub25lIn0.e30.")),
    ).toEqual(REFUSAL);
  });
});

describe("refresh", () => {
  test("rotates the refresh token, and the new access token passes the guard", async () => {
    const { clientId, userId, tokens } = await connectedTokens();

    const res = await refresh(clientId, tokens.refresh_token ?? "");

    expect(res.status).toBe(200);
    const rotated = (await res.json()) as Record<string, string>;
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(
      await auth.verifyMcpRequest(mcpRequest(rotated.access_token)),
    ).toEqual({ ok: true, userId });
  });

  test("a retry with the old token within 30 seconds gets the same rotated tokens", async () => {
    const { clientId, tokens } = await connectedTokens();
    const first = await (
      await refresh(clientId, tokens.refresh_token ?? "")
    ).json();

    const retried = await refresh(clientId, tokens.refresh_token ?? "");

    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      refresh_token: (first as Record<string, string>).refresh_token,
    });
  });

  test("the old token is refused after 30 seconds, and so is the token it rotated to", async () => {
    const { clientId, tokens } = await connectedTokens();
    const rotated = (await (
      await refresh(clientId, tokens.refresh_token ?? "")
    ).json()) as Record<string, string>;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31_000 });

    const replayed = await refresh(clientId, tokens.refresh_token ?? "");

    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({ error: "invalid_grant" });
    const afterReplay = await refresh(clientId, rotated.refresh_token ?? "");
    expect(afterReplay.status).toBe(400);
  });
});

describe("reconnect", () => {
  test("deleting the connection-user makes its tokens stop working", async () => {
    const { clientId, userId, tokens } = await connectedTokens();
    expect(
      await auth.verifyMcpRequest(mcpRequest(tokens.access_token)),
    ).toEqual({ ok: true, userId });

    await auth.deleteConnectionUser(userId);

    expect(
      await auth.verifyMcpRequest(mcpRequest(tokens.access_token)),
    ).toEqual(REFUSAL);
    const refreshed = await refresh(clientId, tokens.refresh_token ?? "");
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("deleting one connection-user leaves another's token working", async () => {
    const kept = await connectedTokens();
    const dropped = await connectedTokens();

    await auth.deleteConnectionUser(dropped.userId);

    expect(
      await auth.verifyMcpRequest(mcpRequest(kept.tokens.access_token)),
    ).toEqual({ ok: true, userId: kept.userId });
  });
});

describe("logging", () => {
  test("no flow, refused or not, writes to the console", async () => {
    const written: string[] = [];
    for (const method of ["debug", "info", "log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map((arg) => String(arg)).join(" "));
      });
    }

    const { clientId, userId, code, verifier, tokens } =
      await connectedTokens();
    const rotated = (await (
      await refresh(clientId, tokens.refresh_token ?? "")
    ).json()) as Record<string, string>;
    await auth.verifyMcpRequest(mcpRequest(rotated.access_token));
    await exchangeCode({ clientId, code }, verifier);
    const unverified = await connectedCode();
    await exchangeCode(unverified, "wrong-verifier");
    await register(["https://evil.example/cb"]);
    await auth.deleteConnectionUser(userId);
    await auth.verifyMcpRequest(mcpRequest(rotated.access_token));

    const secrets = [
      SECRET,
      code,
      verifier,
      unverified.code,
      unverified.verifier,
      tokens.access_token,
      tokens.refresh_token,
      rotated.access_token,
      rotated.refresh_token,
    ];
    for (const line of written) {
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
    expect(written).toEqual([]);
  });
});
