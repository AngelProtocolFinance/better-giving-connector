import { afterEach, expect, test, vi } from "vitest";
import { log } from "./log";

afterEach(() => {
	vi.restoreAllMocks();
});

test("writes one JSON line per event to stdout", () => {
	const out = vi.spyOn(console, "log").mockImplementation(() => {});

	log({ kind: "tool", tool: "campaigns_create", outcome: "ok", ms: 182 });

	expect(out.mock.calls).toEqual([
		['{"kind":"tool","tool":"campaigns_create","outcome":"ok","ms":182}'],
	]);
});

test("writes error events to stderr", () => {
	const out = vi.spyOn(console, "log").mockImplementation(() => {});
	const err = vi.spyOn(console, "error").mockImplementation(() => {});

	log({ kind: "error", where: "mcp", errorName: "TypeError" });

	expect(err.mock.calls).toEqual([
		['{"kind":"error","where":"mcp","errorName":"TypeError"}'],
	]);
	expect(out).not.toHaveBeenCalled();
});
