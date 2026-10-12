import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import { DeploymentKey } from "./key.ts";

const PLAIN = `bgc_${"k".repeat(43)}`;

describe("DeploymentKey", () => {
  const key = new DeploymentKey(PLAIN);

  test.each([
    ["String()", () => String(key)],
    ["template interpolation", () => `${key}`],
    ["JSON.stringify", () => JSON.stringify({ key })],
    ["util.inspect", () => inspect({ key }, { showHidden: true, depth: 5 })],
  ])("%s shows [redacted], never the key", (_, render) => {
    const rendered = render();

    expect(rendered).toContain("[redacted]");
    expect(rendered).not.toContain(PLAIN);
  });

  test("reveal() is the plain key", () => {
    expect(key.reveal()).toBe(PLAIN);
  });
});
