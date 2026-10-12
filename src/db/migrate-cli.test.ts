import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";

const CLI = fileURLToPath(new URL("./migrate-cli.ts", import.meta.url));
const TOKEN = "sentinel-auth-token-4d1e";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "migrate-cli-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true });
});

function runCli(url: string) {
	return spawnSync(process.execPath, ["--import", "tsx", CLI], {
		encoding: "utf8",
		env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: TOKEN },
	});
}

test("names the file database before migrating it", () => {
	const file = join(dir, "dev.db");

	const run = runCli(`file:${file}`);

	expect(run.status).toBe(0);
	expect(run.stdout.split("\n")[0]).toBe(`migrating file:${file}`);
	expect(run.stdout).toContain("applied 0001_better_auth.sql");
});

test("names a remote database by scheme and host, never its token", () => {
	const run = runCli(`http://127.0.0.1:65530/?authToken=${TOKEN}`);

	expect(run.stdout.split("\n")[0]).toBe("migrating http://127.0.0.1:65530");
	expect(run.stdout + run.stderr).not.toContain(TOKEN);
});
