import { z } from "zod";

/** The `cursor` a list tool takes: the previous page's `next_cursor`. */
export const cursor = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The next_cursor of the previous page, to read the page after it. Leave it out for the first page.",
  );

/** The `limit` a list tool takes; the deployment refuses more than 100. */
export const limit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("How many to answer on this page, 1 to 100; 50 when left out.");

/** `path` with the query parameters that are set. */
export function withQuery(
  path: `/${string}`,
  params: Record<string, string | number | undefined>,
): `/${string}` {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) query.set(name, String(value));
  }
  const search = query.toString();
  return search === "" ? path : `${path}?${search}`;
}

/**
 * "2 forms: Coat drive (live), Donation page (live). More on the next page: …" for a list
 * envelope; without `label`, only the count.
 */
export function listLine(
  body: Record<string, unknown> | null,
  [one, many]: [string, string],
  label?: (item: Record<string, unknown>) => string,
): string {
  const items: Record<string, unknown>[] = Array.isArray(body?.data)
    ? body.data
    : [];
  const listed =
    label === undefined || items.length === 0
      ? ""
      : `: ${items.map(label).join(", ")}`;
  const more =
    typeof body?.next_cursor === "string"
      ? " More on the next page: call again with next_cursor."
      : "";
  return `${items.length} ${items.length === 1 ? one : many}${listed}.${more}`;
}
