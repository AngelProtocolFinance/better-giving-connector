import type { Context } from "hono";

/** A `/connector/v1` refusal body (docs/connector-v1.md → Conventions). */
export function refusal(error: string, message: string, fix: string) {
  return { error, message, fix };
}

/** The request's JSON object body; `{}` for anything else. */
export async function bodyOf(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => ({}));
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** Versions as `updated_at`s, a second apart, so two writes never share one. */
export function versionClock() {
  let clock = Date.parse("2026-10-01T00:00:00.000Z");
  return () => new Date((clock += 1000)).toISOString();
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * The page of `items` the request's `limit` and `cursor` name, in the list envelope
 * (docs/connector-v1.md → Lists). The cursor is the last listed id, so a page stays put when an
 * item before it goes.
 */
export function keysetPage<Item extends { id: string }>(
  c: Context,
  items: Item[],
) {
  const limitParam = c.req.query("limit");
  const limit = limitParam === undefined ? DEFAULT_LIMIT : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return c.json(
      refusal(
        "invalid_limit",
        `limit must be a whole number from 1 to ${MAX_LIMIT}.`,
        "Send a smaller limit and page with the cursor.",
      ),
      400,
    );
  }
  const cursor = c.req.query("cursor");
  let start = 0;
  if (cursor !== undefined) {
    const after = Buffer.from(cursor, "base64url").toString();
    const index = items.findIndex(({ id }) => id === after);
    if (index === -1) {
      return c.json(
        refusal(
          "invalid_cursor",
          "cursor is not one this list answered.",
          "Start again from the first page.",
        ),
        400,
      );
    }
    start = index + 1;
  }
  const data = items.slice(start, start + limit);
  const last = data.at(-1);
  return c.json(
    {
      data,
      next_cursor:
        start + limit < items.length && last !== undefined
          ? Buffer.from(last.id).toString("base64url")
          : null,
    },
    200,
  );
}
