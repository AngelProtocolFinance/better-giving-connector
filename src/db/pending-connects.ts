import type { Client, Row } from "@libsql/client";

export interface NewPendingConnect {
  /** 32 random bytes, base64url: the `state` sent to the deployment's allow page */
  state: string;
  oauthQuery: string;
  codeVerifier: string;
  deploymentUrl: string;
  release: string;
  expiresAt: Date;
}

export interface PendingConnect {
  oauthQuery: string;
  codeVerifier: string;
  deploymentUrl: string;
  release: string;
}

export interface ConsumedPendingConnect extends PendingConnect {
  /** past its expiry: the flow still exchanges its code, to revoke the key */
  expired: boolean;
}

function toPendingConnect(row: Row): PendingConnect {
  return {
    oauthQuery: String(row.oauth_query),
    codeVerifier: String(row.code_verifier),
    deploymentUrl: String(row.deployment_url),
    release: String(row.deployment_release),
  };
}

/** The connect attempts in `db` waiting on the deployment's redirect back. */
export function pendingConnects(db: Client) {
  return {
    async create(attempt: NewPendingConnect): Promise<void> {
      await db.execute({
        sql: `INSERT INTO pending_connect (state, oauth_query, code_verifier, deployment_url, deployment_release, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          attempt.state,
          attempt.oauthQuery,
          attempt.codeVerifier,
          attempt.deploymentUrl,
          attempt.release,
          attempt.expiresAt.toISOString(),
        ],
      });
    },

    /**
     * Deletes the attempt and returns it, marked `expired` when it expired at
     * or before `now`; null when there is none. One statement, so of two
     * returns carrying the same state only one gets the attempt.
     */
    async consume(
      state: string,
      now: Date,
    ): Promise<ConsumedPendingConnect | null> {
      const result = await db.execute({
        sql: `DELETE FROM pending_connect WHERE state = ?
          RETURNING oauth_query, code_verifier, deployment_url, deployment_release, expires_at`,
        args: [state],
      });
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        ...toPendingConnect(row),
        expired: new Date(String(row.expires_at)) <= now,
      };
    },

    /** The attempt, left in place; null when there is none or it expired at or before `now`. */
    async peek(state: string, now: Date): Promise<PendingConnect | null> {
      const result = await db.execute({
        sql: `SELECT oauth_query, code_verifier, deployment_url, deployment_release
          FROM pending_connect WHERE state = ? AND expires_at > ?`,
        args: [state, now.toISOString()],
      });
      const row = result.rows[0];
      return row === undefined ? null : toPendingConnect(row);
    },

    /** Deletes the attempts expired at or before `now - graceMs`; returns how many. */
    async sweepExpired(now: Date, graceMs: number): Promise<number> {
      const cutoff = new Date(now.getTime() - graceMs);
      const result = await db.execute({
        sql: "DELETE FROM pending_connect WHERE expires_at <= ?",
        args: [cutoff.toISOString()],
      });
      return result.rowsAffected;
    },
  };
}
