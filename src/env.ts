import { z } from "zod";

const publicUrl = z.url().superRefine((value, ctx) => {
	// refinements still run after z.url() reports its own issue
	if (!URL.canParse(value)) return;
	const url = new URL(value);
	const isLocalhost = url.protocol === "http:" && url.hostname === "localhost";
	if (url.protocol !== "https:" && !isLocalhost) {
		ctx.addIssue("must be https (http only for localhost)");
	}
	if (value.replace(/\/$/, "") !== url.origin) {
		ctx.addIssue("must be an origin, with no path, query or credentials");
	}
});

const secret = z.string().min(32);

const schema = z.object({
	PUBLIC_URL: publicUrl.transform((value) => new URL(value).origin),
	TURSO_DATABASE_URL: z.url({ protocol: /^(libsql|https?|wss?|file)$/ }),
	TURSO_AUTH_TOKEN: z.string().optional(),
	BETTER_AUTH_SECRET: secret,
	CONNECTION_KEY_SECRET: secret,
});

export type Env = z.output<typeof schema>;

/**
 * Parses the service's environment. Throws naming each bad variable and why,
 * never its value; an empty string counts as unset.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
	const present = Object.fromEntries(
		Object.keys(schema.shape).map((name) => [name, source[name] || undefined]),
	);
	const result = schema.safeParse(present);
	if (result.success) return result.data;
	const problems = result.error.issues.map(
		(issue) => `${issue.path.join(".")}: ${issue.message}`,
	);
	throw new Error(`Invalid environment:\n${problems.join("\n")}`);
}

export const env: Env = parseEnv(process.env);
