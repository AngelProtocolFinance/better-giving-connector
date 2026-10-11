// `pnpm db:migrate`: reads only the two Turso variables, not src/env.ts,
// so it runs without the app's other secrets.
import { createDb } from "./index";
import { migrate } from "./migrate";

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
	process.stderr.write("TURSO_DATABASE_URL is not set\n");
	process.exit(1);
}

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
