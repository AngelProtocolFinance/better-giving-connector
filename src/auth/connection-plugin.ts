import {
	getIssuer,
	getOAuthProviderApi,
	getOAuthProviderState,
	type OAuthOptions,
	type Scope,
} from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	isAPIError,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import {
	createDpopReplayStore,
	enforceDpopBinding,
	isDpopBindingError,
	parseAccessTokenAuthorization,
} from "better-auth/oauth2";
import { z } from "zod";
import { isAllowedRedirectUri } from "./redirect-uris";

// Server-only endpoints: never on the HTTP router, callable only as
// `auth.api.*` from this module's facade.
export const connectionPlugin = (opts: {
	provider: OAuthOptions<Scope[]>;
	resource: string;
}) =>
	({
		id: "better-giving-connection",
		// oauth-provider's `validateRedirectUri` guards authorize only; this
		// refuses the client at registration too
		hooks: {
			before: [
				{
					matcher: (ctx) => ctx.path === "/oauth2/register",
					handler: createAuthMiddleware(async (ctx) => {
						const uris: unknown = ctx.body?.redirect_uris;
						const allowed =
							Array.isArray(uris) &&
							uris.every(
								(u) => typeof u === "string" && isAllowedRedirectUri(u),
							);
						if (allowed) return;
						throw new APIError("BAD_REQUEST", {
							error: "invalid_redirect_uri",
							error_description:
								"redirect_uris must be Claude's or ChatGPT's callback",
						});
					}),
				},
			],
		},
		endpoints: {
			// Signs a connection's user in. The `oauth_query` in the body is what
			// lets oauth-provider's after-hook resume the authorize request once
			// the session cookie is set; its answer replaces this one.
			signInConnection: createAuthEndpoint.serverOnly(
				{
					method: "POST",
					body: z.object({ userId: z.string(), oauth_query: z.string() }),
				},
				async (ctx) => {
					const user = await ctx.context.internalAdapter.findUserById(
						ctx.body.userId,
					);
					if (!user) throw new APIError("NOT_FOUND");
					const session = await ctx.context.internalAdapter.createSession(
						user.id,
					);
					await setSessionCookie(ctx, { session, user });
					return ctx.json(null);
				},
			),
			// The refusal oauth-provider's consent endpoint sends on `accept: false`
			// (RFC 6749 §4.1.2.1, `iss` per RFC 9207), without the session that
			// endpoint demands. oauth-provider's `oauth_query` before-hook has
			// verified the signature and stored the query; authorize had already
			// checked its redirect_uri against the client before signing it.
			denyConnection: createAuthEndpoint.serverOnly(
				{ method: "POST", body: z.object({ oauth_query: z.string() }) },
				async (ctx) => {
					const query = new URLSearchParams(
						(await getOAuthProviderState())?.query,
					);
					const redirectUri = query.get("redirect_uri");
					if (!redirectUri) throw new APIError("BAD_REQUEST");
					const url = new URL(redirectUri);
					url.searchParams.append("error", "access_denied");
					url.searchParams.append("error_description", "User denied access");
					const state = query.get("state");
					if (state) url.searchParams.append("state", state);
					url.searchParams.append("iss", getIssuer(ctx, opts.provider));
					return ctx.json({ url: url.toString() });
				},
			),
			// The resource-server check oauth-provider runs for its own userinfo
			// endpoint, plus the audience: active in the database (so deleting
			// its rows revokes it), sender-bound when DPoP-bound, not issued for
			// another resource.
			verifyMcpAccessToken: createAuthEndpoint.serverOnly(
				{
					method: "POST",
					body: z.object({
						authorization: z.string().optional(),
						dpop: z.string().optional(),
						method: z.string(),
						url: z.string(),
					}),
				},
				async (ctx) => {
					const authorization = parseAccessTokenAuthorization(
						ctx.body.authorization,
					);
					// opaque tokens carry no "."; with the JWT plugin off a dotted bearer
					// is never ours, and oauth-provider's JWT path throws a plain Error
					// (a 500) on one
					if (!authorization || authorization.token.includes(".")) {
						return ctx.json(null);
					}
					const provider = getOAuthProviderApi(ctx, opts.provider);
					try {
						const payload = await provider.requireActiveAccessToken(
							authorization.token,
						);
						await enforceDpopBinding({
							payload,
							authorization,
							proofJwt: ctx.body.dpop,
							method: ctx.body.method,
							url: ctx.body.url,
							replayStore: createDpopReplayStore(ctx.context.internalAdapter),
							proofMaxAgeSeconds: opts.provider.dpop?.proofMaxAgeSeconds,
							signingAlgorithms: opts.provider.dpop?.signingAlgorithms,
						});
						// a token issued without `resource` has no audience; /mcp is this
						// server's only resource, so it is /mcp's
						const audience = [payload.aud ?? []].flat();
						const forMcp =
							audience.length === 0 || audience.includes(opts.resource);
						if (!payload.sub || !forMcp) {
							return ctx.json(null);
						}
						return ctx.json({ userId: payload.sub });
					} catch (error) {
						if (isAPIError(error) || isDpopBindingError(error)) {
							return ctx.json(null);
						}
						throw error;
					}
				},
			),
		},
	}) satisfies BetterAuthPlugin;
