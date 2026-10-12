import { type McpOptions, mcp } from "@better-auth/mcp";
import type { Client } from "@libsql/client";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { connectionUsers } from "./connection-users.ts";
import { libsqlDialect } from "./libsql-dialect.ts";
import { isAllowedRedirectUri } from "./redirect-allowlist.ts";

export const AUTH_BASE_PATH = "/api/auth";
export const MCP_PATH = "/mcp";
/** The connect flow: where `/authorize` sends a browser that has no session. */
export const CONNECT_PATH = "/connect";

export const CODE_SECONDS = 10 * 60;
export const ACCESS_TOKEN_SECONDS = 60 * 60;

/**
 * A connection-user's session only carries one authorization from the connect
 * flow to the code exchange, which refuses a code whose session has expired:
 * so it outlives the code (`CODE_SECONDS`) and nothing more. Refresh doesn't
 * read it.
 */
const SESSION_SECONDS = 15 * 60;

export interface AuthDeps {
  db: Client;
  /** `PUBLIC_URL`: the issuer, and the origin of the `/mcp` resource */
  publicUrl: string;
  /** `BETTER_AUTH_SECRET` */
  secret: string;
}

/** The rules this service adds to the provider's own request checks. */
function requestPolicy(resource: string) {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path === "/oauth2/register") return registrationPolicy(ctx.body);
    if (ctx.path === "/oauth2/authorize") {
      // without a resource the provider issues an opaque token, which the
      // /mcp guard can't verify; any other resource it refuses itself
      const isForm = ctx.method === "POST";
      const params = asRecord(isForm ? ctx.body : ctx.query);
      if (params.resource !== undefined) return;
      const withResource = { ...params, resource };
      return {
        context: isForm ? { body: withResource } : { query: withResource },
      };
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Only allow-listed callbacks may register; see `redirect-allowlist.ts`. */
function registrationPolicy(body: unknown) {
  const metadata = asRecord(body);
  const redirectUris = metadata.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    !redirectUris.every(
      (uri): uri is string =>
        typeof uri === "string" && isAllowedRedirectUri(uri),
    )
  ) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_redirect_uri",
      error_description:
        "redirect_uris must be Claude's or ChatGPT's OAuth callback, or an http loopback URI",
    });
  }
  // 1.7.7 defaults an omitted type to `web`, which refuses loopback; every
  // allow-listed form is valid for `native`
  if (metadata.application_type === undefined) {
    return {
      context: { body: { ...metadata, application_type: "native" } },
    };
  }
}

type McpProvider = ReturnType<typeof mcp>;
type Endpoint = NonNullable<BetterAuthPlugin["endpoints"]>[string];

/**
 * `mcp()`, its endpoints each narrowed to the `Endpoint` they are: under this
 * repo's `exactOptionalPropertyTypes`, the OpenAPI metadata they declare
 * (`items?: undefined`) doesn't check against `BetterAuthPlugin`.
 */
function mcpProvider(options: McpOptions) {
  return mcp(options) as Omit<McpProvider, "endpoints"> & {
    endpoints: {
      [K in keyof McpProvider["endpoints"]]: McpProvider["endpoints"][K] &
        Endpoint;
    };
  };
}

/** better-auth's options for this service. Shared with `cli.config.ts`, which generates the schema from them. */
export function authOptions({ db, publicUrl, secret }: AuthDeps) {
  const origin = new URL(publicUrl).origin;
  const resource = `${origin}${MCP_PATH}`;
  return {
    appName: "Better Giving connector",
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret,
    database: {
      dialect: libsqlDialect(db),
      type: "sqlite",
      transaction: false,
    },
    // free-text lines and raw error objects: src/log.ts's allow-list has no place for either
    logger: { disabled: true },
    trustedOrigins: [origin],
    session: { expiresIn: SESSION_SECONDS, disableSessionRefresh: true },
    // on everywhere, not only where NODE_ENV is production (better-auth's default);
    // a serverless instance's memory store counts only its own requests
    rateLimit: { enabled: true, storage: "database" },
    hooks: { before: requestPolicy(resource) },
    plugins: [
      jwt({ jwt: { issuer: origin } }),
      mcpProvider({
        resource,
        loginPage: `${origin}${CONNECT_PATH}`,
        // never shown: `connectionSignIn` accepts on the user's behalf, since
        // the deployment's own Allow screen is the consent
        consentPage: `${origin}${CONNECT_PATH}`,
        codeExpiresIn: CODE_SECONDS,
        accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
        scopes: ["offline_access"],
        grantTypes: ["authorization_code", "refresh_token"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // no session may create, read or change a client: DCR is the only way in
        clientPrivileges: () => false,
        // per IP, and every user of a chat app arrives from its few egress IPs
        rateLimit: {
          register: { window: 60, max: 60 },
          token: { window: 60, max: 600 },
        },
      }),
      connectionUsers(),
    ],
  } satisfies BetterAuthOptions;
}
