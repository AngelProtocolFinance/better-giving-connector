import {
	getOAuthProviderApi,
	type OAuthOptions,
	type Scope,
} from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, isAPIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import {
	createDpopReplayStore,
	enforceDpopBinding,
	isDpopBindingError,
	parseAccessTokenAuthorization,
} from "better-auth/oauth2";
import { z } from "zod";

// Server-only endpoints: never on the HTTP router, callable only as
// `auth.api.*` from this module's facade.
export const connectionPlugin = (opts: {
	provider: OAuthOptions<Scope[]>;
	resource: string;
}) =>
	({
		id: "better-giving-connection",
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
			// The resource-server check oauth-provider runs for its own userinfo
			// endpoint, plus the audience: active in the database (so deleting
			// its rows revokes it), sender-bound when DPoP-bound, issued for
			// /mcp.
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
					if (!authorization) return ctx.json(null);
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
						const audience = [payload.aud ?? []].flat();
						if (!payload.sub || !audience.includes(opts.resource)) {
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
