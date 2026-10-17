import { createHash } from "node:crypto";
import type { ActionName } from "./contract";

const KEYED = new Set<ActionName>(["campaigns.create", "donations.record"]);

export const isKeyedAction = (action: ActionName): boolean => KEYED.has(action);

/**
 * JSON with object keys sorted at every level. Arrays keep their order.
 * A key whose value is `undefined` is left out, as `JSON.stringify` leaves it out.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	const entries = Object.entries(value).filter(
		(entry) => entry[1] !== undefined,
	);
	entries.sort((left, right) =>
		left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
	);
	return `{${entries
		.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
		.join(",")}}`;
}

/** A stable key for one connection, one action and one validated input. Never log it. */
export function idempotencyKey(
	userId: string,
	action: ActionName,
	input: unknown,
): string {
	const payload = `bgc-idem-v1\n${userId}\n${action}\n${canonicalJson(input)}`;
	return createHash("sha256").update(payload).digest("base64url");
}
