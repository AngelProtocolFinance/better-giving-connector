import { type Client, createClient } from "@libsql/client";

export type Db = Client;

export function createDb(cfg: { url: string; authToken?: string }): Db {
	return createClient({ url: cfg.url, authToken: cfg.authToken });
}

export { type Connection, type Connections, connections } from "./connections";
export { ConnectionKeyUnreadable } from "./key-cipher";
