import { HTTPException } from "hono/http-exception";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.ts";
import { createLogger } from "./log.ts";

const SECRET = "bgk_live_9f2c41d7e0a3b5c8";

function appWithLog() {
  const lines: string[] = [];
  const app = createApp({ log: createLogger((line) => lines.push(line)) });
  return { app, lines };
}

describe("createApp", () => {
  test("GET /health answers 200 ok", async () => {
    const { app } = appWithLog();
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("an unknown path answers a JSON 404", async () => {
    const { app } = appWithLog();
    const res = await app.request("/no-such-route?key=x");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "route_not_found",
      detail: "No route for /no-such-route.",
    });
  });

  test("a thrown error answers a generic 500 and logs only its class", async () => {
    const { app, lines } = appWithLog();
    app.get("/boom/:id", () => {
      throw new Error(`deployment refused key ${SECRET}`);
    });

    const res = await app.request("/boom/7");

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain(SECRET);
    expect(JSON.parse(body)).toMatchObject({
      status: 500,
      code: "internal_error",
    });
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({
      event: "unhandled_error",
      method: "GET",
      route: "/boom/:id",
      errorName: "Error",
    });
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain("refused");
    }
  });

  test("each request logs its method, route pattern, status and duration", async () => {
    const { app, lines } = appWithLog();
    app.get("/items/:id", (c) => c.json({ id: c.req.param("id") }, 200));

    await app.request(`/items/4242?token=${SECRET}`, { method: "GET" });
    await app.request("/nowhere/4242");

    expect(lines.map((line) => JSON.parse(line))).toStrictEqual([
      {
        event: "request",
        method: "GET",
        route: "/items/:id",
        status: 200,
        durationMs: expect.any(Number),
      },
      {
        event: "request",
        method: "GET",
        route: null,
        status: 404,
        durationMs: expect.any(Number),
      },
    ]);
    expect(lines.join("\n")).not.toMatch(/4242|token/);
  });

  test("a thrown HTTPException keeps its own status and is not logged as unhandled", async () => {
    const { app, lines } = appWithLog();
    app.get("/guarded", () => {
      throw new HTTPException(401, { message: "Sign in first." });
    });

    const res = await app.request("/guarded");

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Sign in first.");
    expect(lines.join("\n")).not.toContain("unhandled_error");
  });

  test("an error's code is logged only while it reads as an identifier", async () => {
    const { app, lines } = appWithLog();
    app.get("/db", () => {
      throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
    });
    app.get("/odd", () => {
      throw Object.assign(new Error("x"), { code: `key=${SECRET} ` });
    });

    await app.request("/db");
    await app.request("/odd");

    const errors = lines
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === "unhandled_error");
    expect(errors).toStrictEqual([
      {
        event: "unhandled_error",
        method: "GET",
        route: "/db",
        errorName: "Error",
        errorCode: "SQLITE_BUSY",
      },
      {
        event: "unhandled_error",
        method: "GET",
        route: "/odd",
        errorName: "Error",
      },
    ]);
  });
});
