import { afterAll, expect, test, vi } from "vitest";
import { parseEnv } from "./env";

// env.ts parses process.env at import, so the import above needs a valid one
vi.hoisted(() => {
	vi.stubEnv("PUBLIC_URL", "http://localhost:3000");
	vi.stubEnv("TURSO_DATABASE_URL", "file:test.db");
	vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32));
	vi.stubEnv("CONNECTION_KEY_SECRET", "y".repeat(32));
	vi.stubEnv("CRON_SECRET", "z".repeat(32));
});
afterAll(() => {
	vi.unstubAllEnvs();
});

const valid = {
	PUBLIC_URL: "https://connect.better.giving",
	TURSO_DATABASE_URL: "libsql://connector-better-giving.turso.io",
	TURSO_AUTH_TOKEN: "sentinel-token-0123456789",
	BETTER_AUTH_SECRET: "sentinel-auth-secret-0123456789abcdef",
	CONNECTION_KEY_SECRET: "sentinel-key-secret-0123456789abcdef",
	CRON_SECRET: "sentinel-cron-secret-0123456789abcdef",
};

function messageOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected a throw");
}

test("a valid environment parses", () => {
	expect(parseEnv(valid)).toStrictEqual(valid);
});

test.each([
	"BETTER_AUTH_SECRET",
	"CONNECTION_KEY_SECRET",
	"CRON_SECRET",
] as const)("a missing %s names the variable and echoes no value", (name) => {
	const message = messageOf(() => parseEnv({ ...valid, [name]: undefined }));

	expect(message).toContain(name);
	for (const value of Object.values(valid)) {
		expect(message).not.toContain(value);
	}
});

test("an empty string counts as unset", () => {
	expect(() => parseEnv({ ...valid, BETTER_AUTH_SECRET: "" })).toThrow(
		/BETTER_AUTH_SECRET/,
	);
	expect(
		parseEnv({ ...valid, TURSO_AUTH_TOKEN: "" }).TURSO_AUTH_TOKEN,
	).toBeUndefined();
});

test("a secret under 32 characters is refused without echoing it", () => {
	const short = "sentinel-31-characters-long-xyz";
	const message = messageOf(() =>
		parseEnv({ ...valid, BETTER_AUTH_SECRET: short }),
	);

	expect(message).toContain("BETTER_AUTH_SECRET");
	expect(message).not.toContain(short);
});

test("PUBLIC_URL is an https origin, or http only on localhost", () => {
	expect(() =>
		parseEnv({ ...valid, PUBLIC_URL: "http://connect.better.giving" }),
	).toThrow(/PUBLIC_URL/);
	expect(() =>
		parseEnv({ ...valid, PUBLIC_URL: "https://connect.better.giving/mcp" }),
	).toThrow(/PUBLIC_URL/);
	expect(
		parseEnv({ ...valid, PUBLIC_URL: "http://localhost:3000/" }).PUBLIC_URL,
	).toBe("http://localhost:3000");
});
