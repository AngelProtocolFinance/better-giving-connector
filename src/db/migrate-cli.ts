// `pnpm db:migrate`: reads only the two Turso variables, not src/env.ts,
// so it runs without the app's other secrets.
import { createDb } from "./index";
import { migrate } from "./migrate";

const url = process.env.TURSO_DATABASE_URL;
const target = url === undefined ? null : URL.parse(url);
if (!url || !target) {
	process.stderr.write("TURSO_DATABASE_URL is not set to a database URL\n");
	process.exit(1);
}

// scheme and host only: a libsql: URL may carry its token as ?authToken=
process.stdout.write(
	target.protocol === "file:"
		? `migrating file:${target.pathname}\n`
		: `migrating ${target.protocol}//${target.host}\n`,
);
const db = createDb({ url, authToken: process.env.TURSO_AUTH_TOKEN });
try {
	const applied = await migrate(db);
	process.stdout.write(
		applied.length > 0
			? `applied ${applied.join(", ")}\n`
			: "nothing to apply\n",
	);
} finally {
	db.close();
}
