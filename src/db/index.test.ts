import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Runs createDb in a fresh node where the native `libsql` module can't load,
// as on a host whose bundle left it out.
const PROBE = `
import { registerHooks } from "node:module";
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "libsql") throw new Error("native libsql unavailable");
		return next(specifier, context);
	},
});
const { createDb } = await import(process.env.DB_MODULE);
const attempt = (url) => {
	try {
		createDb({ url, authToken: "t" }).close();
		return "ok";
	} catch {
		return "failed";
	}
};
process.stdout.write(JSON.stringify({
	remote: attempt("libsql://db.example.turso.io"),
	local: attempt(":memory:"),
}));
`;

test("a libsql: database opens without loading the native module; :memory: needs it", () => {
	const run = spawnSync(
		process.execPath,
		["--import", "tsx", "--input-type=module", "-e", PROBE],
		{
			encoding: "utf8",
			env: {
				...process.env,
				DB_MODULE: fileURLToPath(new URL("./index.ts", import.meta.url)),
			},
		},
	);

	expect(run.stderr).toBe("");
	expect(JSON.parse(run.stdout)).toEqual({ remote: "ok", local: "failed" });
});
