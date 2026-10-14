import { createRequire } from "node:module";
import type { Client } from "@libsql/client";
import { createClient as createHttpClient } from "@libsql/client/http";

export type Db = Client;

// Remote URLs take the pure-HTTP client. The local one loads libSQL's native
// module, so it's required only when a file: or :memory: URL asks for it.
export function createDb(cfg: { url: string; authToken?: string }): Db {
	const config = { url: cfg.url, authToken: cfg.authToken };
	if (cfg.url === ":memory:" || cfg.url.startsWith("file:")) {
		const local: typeof import("@libsql/client/sqlite3") = createRequire(
			import.meta.url,
		)("@libsql/client/sqlite3");
		return local.createClient(config);
	}
	return createHttpClient(config);
}

export { type Connection, type Connections, connections } from "./connections";
export {
	ConnectionKeySecretMismatch,
	ConnectionKeyUnreadable,
} from "./key-cipher";
