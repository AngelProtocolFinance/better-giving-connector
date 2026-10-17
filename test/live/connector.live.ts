import { test } from "vitest";
import { readLiveEnv } from "./env";
import { runLiveHarness } from "./harness";

const { origin, code } = readLiveEnv();

test("the minimum tools run against the deployment", async () => {
	await runLiveHarness({
		origin,
		code,
		fetch: globalThis.fetch,
		resultsPath: "test/live/results.ndjson",
	});
});
