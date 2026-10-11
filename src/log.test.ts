import { describe, expect, test } from "vitest";
import { createLogger } from "./log.ts";

describe("createLogger", () => {
  test("writes only the allow-listed fields, whatever the entry carries", () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    const widened = {
      event: "unhandled_error",
      method: "POST",
      route: "/mcp",
      errorName: "TypeError",
      message: "key bgk_live_9f2c41d7e0a3b5c8",
      body: { donor: "Ada" },
    } as const;

    log(widened);
    log({
      event: "unhandled_error",
      method: "GET",
      route: "/",
      errorName: "Error",
      // @ts-expect-error a field outside the allow-list is a type error
      stack: "at x",
    });

    expect(lines.map((line) => JSON.parse(line))).toStrictEqual([
      {
        event: "unhandled_error",
        method: "POST",
        route: "/mcp",
        errorName: "TypeError",
      },
      {
        event: "unhandled_error",
        method: "GET",
        route: "/",
        errorName: "Error",
      },
    ]);
  });

  test("a tool call keeps only its tool name and outcome, at error level when it threw", () => {
    const written: [string, string][] = [];
    const log = createLogger((line, level) => written.push([line, level]));
    const widened = {
      event: "tool_call",
      tool: "connection_status",
      outcome: "ok",
      arguments: { donor: "Ada" },
      result: "Connected to https://give.example.org",
    } as const;

    log(widened);
    log({
      event: "tool_call",
      tool: "connection_status",
      outcome: "error",
      errorName: "LibsqlError",
      errorCode: "SQLITE_ERROR",
    });

    expect(
      written.map(([line, level]) => [JSON.parse(line), level]),
    ).toStrictEqual([
      [
        { event: "tool_call", tool: "connection_status", outcome: "ok" },
        "info",
      ],
      [
        {
          event: "tool_call",
          tool: "connection_status",
          outcome: "error",
          errorName: "LibsqlError",
          errorCode: "SQLITE_ERROR",
        },
        "error",
      ],
    ]);
  });
});
