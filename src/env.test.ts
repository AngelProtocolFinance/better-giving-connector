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
	PUBLIC_URL: "https://app.connect.better.giving",
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
	expect(() => parseEnv({ ...valid, TURSO_AUTH_TOKEN: "" })).toThrow(
		/TURSO_AUTH_TOKEN/,
	);
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
		parseEnv({ ...valid, PUBLIC_URL: "http://app.connect.better.giving" }),
	).toThrow(/PUBLIC_URL/);
	expect(() =>
		parseEnv({ ...valid, PUBLIC_URL: "https://app.connect.better.giving/mcp" }),
	).toThrow(/PUBLIC_URL/);
	expect(
		parseEnv({ ...valid, PUBLIC_URL: "http://localhost:3000/" }).PUBLIC_URL,
	).toBe("http://localhost:3000");
});

test("a remote database without a token is refused alongside other problems", () => {
	const message = messageOf(() =>
		parseEnv({ ...valid, TURSO_AUTH_TOKEN: undefined, CRON_SECRET: undefined }),
	);

	expect(message).toMatch(/^TURSO_AUTH_TOKEN: /m);
	expect(message).toMatch(/^CRON_SECRET: /m);
	for (const value of Object.values(valid)) {
		expect(message).not.toContain(value);
	}
});

test("a file: database needs no token off Vercel", () => {
	const local = { ...valid, TURSO_DATABASE_URL: "file:local.db" };

	expect(
		parseEnv({ ...local, TURSO_AUTH_TOKEN: undefined }).TURSO_AUTH_TOKEN,
	).toBeUndefined();
	expect(parseEnv({ ...local, VERCEL: "" }).TURSO_DATABASE_URL).toBe(
		"file:local.db",
	);
});

test("a file: database is refused on Vercel without echoing it", () => {
	const message = messageOf(() =>
		parseEnv({
			...valid,
			TURSO_DATABASE_URL: "file:sentinel-local.db",
			VERCEL: "1",
		}),
	);

	expect(message).toMatch(/^TURSO_DATABASE_URL: .*VERCEL/m);
	expect(message).not.toContain("sentinel");
	expect(parseEnv({ ...valid, VERCEL: "1" })).toStrictEqual(valid);
});
