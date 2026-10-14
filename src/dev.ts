import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createDb } from "./db";
import { migrate } from "./db/migrate";
import { env } from "./env";

// Migrates on every start, so it refuses anything but a local file database.
if (!env.TURSO_DATABASE_URL.startsWith("file:")) {
	throw new Error("pnpm dev runs on a file: TURSO_DATABASE_URL only");
}
const port = Number(new URL(env.PUBLIC_URL).port);
if (!port) {
	throw new Error(
		"pnpm dev needs a port in PUBLIC_URL, e.g. http://localhost:3000",
	);
}

const db = createDb({ url: env.TURSO_DATABASE_URL });
await migrate(db);
serve({
	fetch: createApp({ env, db, fetch }).fetch,
	port,
	hostname: "localhost",
});
