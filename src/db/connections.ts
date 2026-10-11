import type { Client } from "@libsql/client";
import { keyCipher } from "./crypto.ts";

export interface NewConnection {
  userId: string;
  deploymentUrl: string;
  release: string;
  /** the deployment key, in plaintext */
  key: string;
}

export interface Connection {
  id: string;
  deploymentUrl: string;
  release: string;
  key: string;
}

export class ConnectionExists extends Error {
  override name = "ConnectionExists";
  constructor() {
    super("this user already has a connection");
  }
}

/** The connection rows in `db`, their keys sealed under `secret` (`CONNECTION_KEY_SECRET`). */
export function connectionStore(db: Client, secret: string) {
  const cipher = keyCipher(secret);
  return {
    async create(connection: NewConnection): Promise<{ id: string }> {
      const id = crypto.randomUUID();
      const sealed = await cipher.seal(id, connection.key);
      const inserted = await db.execute({
        sql: `INSERT INTO connection (id, user_id, deployment_url, deployment_release, key_ciphertext)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (user_id) DO NOTHING`,
        args: [
          id,
          connection.userId,
          connection.deploymentUrl,
          connection.release,
          sealed,
        ],
      });
      if (inserted.rowsAffected === 0) throw new ConnectionExists();
      return { id };
    },

    async getByUserId(userId: string): Promise<Connection | null> {
      const result = await db.execute({
        sql: "SELECT id, deployment_url, deployment_release, key_ciphertext FROM connection WHERE user_id = ?",
        args: [userId],
      });
      const row = result.rows[0];
      if (row === undefined) return null;
      const id = String(row.id);
      return {
        id,
        deploymentUrl: String(row.deployment_url),
        release: String(row.deployment_release),
        key: await cipher.open(
          id,
          new Uint8Array(row.key_ciphertext as ArrayBuffer),
        ),
      };
    },

    async deleteByUserId(userId: string): Promise<void> {
      await db.execute({
        sql: "DELETE FROM connection WHERE user_id = ?",
        args: [userId],
      });
    },

    async deleteById(id: string): Promise<void> {
      await db.execute({
        sql: "DELETE FROM connection WHERE id = ?",
        args: [id],
      });
    },
  };
}
