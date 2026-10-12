import { inspect } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { signIn, startApp, type TestApp } from "../test-app.ts";
import { usableConnection } from "./tool.ts";

const KEY = `bgc_${"k".repeat(43)}`;

let t: TestApp;

afterEach(() => {
  t.db.close();
});

describe("usableConnection", () => {
  test("hands over the key wrapped: printing or serialising the connection shows [redacted]", async () => {
    t = await startApp();
    const { userId } = await signIn(t);
    await t.connections.create({
      userId,
      deploymentUrl: "https://give.hopeshelter.org",
      release: "1.4.0",
      key: KEY,
    });

    const connection = await usableConnection({ ...t, userId });

    for (const rendered of [
      String(connection?.key),
      `${connection?.key}`,
      JSON.stringify(connection),
      inspect(connection),
    ]) {
      expect(rendered).toContain("[redacted]");
      expect(rendered).not.toContain(KEY);
    }
  });
});
