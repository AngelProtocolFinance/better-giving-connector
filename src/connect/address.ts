import { isIP } from "node:net";

export type ParsedAddress =
  | { ok: true; origin: string }
  | { ok: false; error: "required" | "not_an_address" | "email" };

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The deployment origin an operator's typed donation page address names: https, the host
 * lowercased, path, query and hash dropped.
 */
export function parseAddress(typed: string): ParsedAddress {
  const trimmed = typed.trim();
  if (trimmed === "") return { ok: false, error: "required" };
  const hasScheme = SCHEME.test(trimmed);
  if (!hasScheme && trimmed.includes("@")) return { ok: false, error: "email" };
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, error: "not_an_address" };
  }
  if (url.protocol === "http:") url.protocol = "https:";
  const host = url.hostname;
  if (
    url.protocol !== "https:" ||
    !host.includes(".") ||
    // URL brackets an IPv6 host and rewrites an IPv4 shorthand to dotted form
    host.startsWith("[") ||
    isIP(host) !== 0
  ) {
    return { ok: false, error: "not_an_address" };
  }
  return { ok: true, origin: url.origin };
}
