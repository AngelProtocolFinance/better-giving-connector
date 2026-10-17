import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fakeDeployment, MVP_ACTIONS } from "./fake-deployment";
import { readLiveEnv } from "./live/env";
import { runLiveHarness } from "./live/harness";

test("readLiveEnv refuses to run until LIVE_ORIGIN and LIVE_CODE are set", () => {
	expect(() => readLiveEnv({}, join(tmpdir(), "missing.env.live"))).toThrow(
		"set LIVE_ORIGIN and LIVE_CODE",
	);
});

test("readLiveEnv takes the environment first and the file for the rest", () => {
	const dir = mkdtempSync(join(tmpdir(), "live-env-"));
	const file = join(dir, ".env.live");
	writeFileSync(file, 'LIVE_ORIGIN="https://from.file"\nLIVE_CODE=from-file\n');

	expect(readLiveEnv({}, file)).toEqual({
		origin: "https://from.file",
		code: "from-file",
	});
	expect(readLiveEnv({ LIVE_ORIGIN: "https://from.env" }, file)).toEqual({
		origin: "https://from.env",
		code: "from-file",
	});
});

test("the harness runs the minimum tools against the fake and records no secrets", async () => {
	const dep = fakeDeployment({ name: "Hope Shelter" });
	dep.setActions(MVP_ACTIONS);
	const dir = mkdtempSync(join(tmpdir(), "live-results-"));
	const resultsPath = join(dir, "results.ndjson");
	const now = new Date("2026-10-17T15:04:05.000Z");

	await runLiveHarness({
		origin: dep.origin,
		code: dep.mintCode(),
		fetch: dep.fetch,
		resultsPath,
		now,
	});

	const text = readFileSync(resultsPath, "utf8");
	const rows = text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const key = dep.issuedKeys[0] ?? "";

	expect(key).not.toBe("");
	expect(text).not.toContain(key);
	expect(text).not.toContain("connector live test");
	expect(
		rows.every(
			(row) => Object.keys(row).toSorted().join() === "bytes,ms,outcome,tool",
		),
	).toBe(true);
	expect(
		rows
			.filter((row) => row.tool === "create_campaign")
			.map((row) => row.outcome),
	).toEqual(["ok", "replay"]);
	expect(
		rows
			.filter((row) => row.tool === "record_donation")
			.map((row) => row.outcome),
	).toEqual(["ok", "replay"]);
	const unknown = rows.filter((row) => row.outcome === "unknown_action");
	expect(unknown).toHaveLength(10);
	expect(rows.at(-1)).toMatchObject({
		tool: "list_campaigns",
		outcome: "key_refused",
	});
	expect(dep.issuedKeys).toHaveLength(1);
});
