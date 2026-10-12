import type { Client } from "@libsql/client";
import { Kysely } from "kysely";
import { libsqlDialect } from "./libsql-dialect.ts";
import { ACCESS_TOKEN_SECONDS, CODE_SECONDS } from "./options.ts";

// better-auth writes dates on SQLite as Date.toISOString() text, so text order is time order
type IsoDate = string;

/** The columns of the auth tables (migrations/0002, 0004) the sweep reads. */
interface SweptTables {
  connected_client: { client_id: string };
  oauthClient: { clientId: string; createdAt: IsoDate | null };
  oauthClientResource: { clientId: string };
  oauthConsent: { clientId: string };
  user: { id: string; createdAt: IsoDate };
  oauthRefreshToken: {
    userId: string;
    expiresAt: IsoDate;
    revoked: IsoDate | null;
  };
}

/**
 * A connection-user this old with no live refresh token holds nothing a chat
 * app can use: its code expired unexchanged, or the last access token its
 * grant issued has run out (an access token is a JWT, never stored, so its
 * lifetime is waited out rather than looked up).
 */
const STALE_AFTER_MS =
  (CODE_SECONDS + ACCESS_TOKEN_SECONDS) * 1000 + 5 * 60_000;

/** Open registration lets anyone add a client: one this old that never connected is junk. */
const UNUSED_CLIENT_AFTER_MS = 24 * 60 * 60_000;

export function sweepQueries(client: Client) {
  const db = new Kysely<SweptTables>({ dialect: libsqlDialect(client) });
  return {
    /** The oldest `limit` connection-users no chat app can use any more. */
    async staleConnectionUsers(now: Date, limit: number): Promise<string[]> {
      const rows = await db
        .selectFrom("user")
        .select("user.id")
        .where(
          "user.createdAt",
          "<",
          new Date(now.getTime() - STALE_AFTER_MS).toISOString(),
        )
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("oauthRefreshToken")
                .select("oauthRefreshToken.userId")
                .whereRef("oauthRefreshToken.userId", "=", "user.id")
                .where("oauthRefreshToken.revoked", "is", null)
                .where("oauthRefreshToken.expiresAt", ">", now.toISOString()),
            ),
          ),
        )
        .orderBy("user.createdAt")
        .limit(limit)
        .execute();
      return rows.map((row) => row.id);
    },

    /** Keeps `clientId` from the sweep for good. */
    async markClientConnected(clientId: string): Promise<void> {
      await db
        .insertInto("connected_client")
        .values({ client_id: clientId })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
    },

    /**
     * Deletes the oldest `limit` clients past `UNUSED_CLIENT_AFTER_MS` that no
     * connection completed through. The check and the delete are one
     * statement, so a client marked meanwhile is kept.
     */
    async deleteUnusedClients(now: Date, limit: number): Promise<number> {
      const unused = db
        .selectFrom("oauthClient")
        .select("oauthClient.clientId")
        .where(
          "oauthClient.createdAt",
          "<",
          new Date(now.getTime() - UNUSED_CLIENT_AFTER_MS).toISOString(),
        )
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("connected_client")
                .select("connected_client.client_id")
                .whereRef(
                  "connected_client.client_id",
                  "=",
                  "oauthClient.clientId",
                ),
            ),
          ),
        )
        .orderBy("oauthClient.createdAt")
        .limit(limit);
      const deleted = (
        await db
          .deleteFrom("oauthClient")
          .where("clientId", "in", unused)
          .returning("clientId")
          .execute()
      ).map((row) => row.clientId);
      if (deleted.length === 0) return 0;
      // the cascades in migrations/0002 hold only where SQLite's foreign_keys is on
      for (const model of ["oauthClientResource", "oauthConsent"] as const) {
        await db.deleteFrom(model).where("clientId", "in", deleted).execute();
      }
      return deleted.length;
    },
  };
}
