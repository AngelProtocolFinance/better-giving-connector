import { afterEach, expect, test, vi } from "vitest";
import type { ActionName } from "./deployment";
import { type LogEvent, log } from "./log";

const SENTINEL = "SENTINEL-4e2b";
// Silences stdout and stderr; returns a reader of the lines written to either.
function captureLines() {
	const out = vi.spyOn(console, "log").mockImplementation(() => {});
	const err = vi.spyOn(console, "error").mockImplementation(() => {});
	return () => [...out.mock.calls, ...err.mock.calls].map(([line]) => line);
}

afterEach(() => {
	vi.restoreAllMocks();
});

test("writes one JSON line per event to stdout", () => {
	const out = vi.spyOn(console, "log").mockImplementation(() => {});

	log({ kind: "tool", tool: "campaigns.create", outcome: "ok", ms: 182 });

	expect(out.mock.calls).toEqual([
		['{"kind":"tool","tool":"campaigns.create","outcome":"ok","ms":182}'],
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

test.each([
	{ kind: "tool", tool: "donors.get", outcome: "ok", ms: 9 },
	{ kind: "connect", step: "exchange", outcome: "ok" },
	{ kind: "error", where: "mcp", errorName: "TypeError" },
	{ kind: "error", where: "disconnect", errorName: "Unreachable" },
	{ kind: "sweep", connections: 3, ms: 840 },
] satisfies LogEvent[])(
	"writes only the fields a $kind event names",
	(fields) => {
		const written = captureLines();
		const event = { ...fields, input: SENTINEL, body: { detail: SENTINEL } };

		log(event);

		expect(written()).toEqual([JSON.stringify(fields)]);
	},
);

test("writes a tool name outside the actions as unknown", () => {
	const written = captureLines();
	const tool = SENTINEL as ActionName;

	log({ kind: "tool", tool, outcome: "failed", ms: 1 });

	expect(written()).toEqual([
		'{"kind":"tool","tool":"unknown","outcome":"failed","ms":1}',
	]);
});
