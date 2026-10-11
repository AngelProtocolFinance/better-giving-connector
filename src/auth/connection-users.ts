import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

/**
 * Everything better-auth keys to a user besides the user row itself, deleted
 * explicitly: the cascades in migrations/0002 hold only where SQLite's
 * `foreign_keys` is on.
 */
const USER_OWNED_MODELS = [
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthConsent",
  "session",
  "account",
] as const;

/**
 * Server-only endpoints for the users that stand for connections: no email,
 * password or social login reaches them, so nothing here is routed over HTTP.
 */
export const connectionUsers = () =>
  ({
    id: "connection-users",
    endpoints: {
      /** A new connection-user, signed in: the session cookie comes back in the response headers. */
      createConnectionSession: createAuthEndpoint.serverOnly(
        { method: "POST" },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.createUser(
            {
              // the user table requires a unique email; `.invalid` never resolves (RFC 2606)
              email: `${crypto.randomUUID()}@connection.invalid`,
              name: "Better Giving connection",
            },
            { method: "connection" },
          );
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ userId: user.id });
        },
      ),
      deleteConnectionUser: createAuthEndpoint.serverOnly(
        { method: "POST", body: z.object({ userId: z.string().min(1) }) },
        async (ctx) => {
          const { userId } = ctx.body;
          for (const model of USER_OWNED_MODELS) {
            await ctx.context.adapter.deleteMany({
              model,
              where: [{ field: "userId", value: userId }],
            });
          }
          await ctx.context.adapter.delete({
            model: "user",
            where: [{ field: "id", value: userId }],
          });
          return ctx.json({ deleted: true });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
