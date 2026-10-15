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

const fields = z.object({
	PUBLIC_URL: publicUrl.transform((value) => new URL(value).origin),
	TURSO_DATABASE_URL: z.url({ protocol: /^(libsql|https?|wss?|file)$/ }),
	TURSO_AUTH_TOKEN: z.string().optional(),
	BETTER_AUTH_SECRET: secret,
	CONNECTION_KEY_SECRET: secret,
	CRON_SECRET: secret,
	// OpenAI domain verification. Unset (or empty) leaves the well-known route at 404.
	OPENAI_APPS_CHALLENGE: z.string().min(1).max(2048).optional(),
});

const database = fields.pick({
	TURSO_DATABASE_URL: true,
	TURSO_AUTH_TOKEN: true,
});

export type Env = z.output<typeof fields>;

// `when` keeps both database rules running while another variable fails, so
// one boot names every problem
function schemaFor(onVercel: boolean) {
	const databaseParses = (payload: { value: unknown }) =>
		database.safeParse(payload.value).success;
	return fields
		.refine(
			(env) =>
				env.TURSO_DATABASE_URL.startsWith("file:") ||
				env.TURSO_AUTH_TOKEN !== undefined,
			{
				when: databaseParses,
				path: ["TURSO_AUTH_TOKEN"],
				message: "required unless TURSO_DATABASE_URL is a file: URL",
			},
		)
		.refine(
			(env) => !(onVercel && env.TURSO_DATABASE_URL.startsWith("file:")),
			{
				when: databaseParses,
				path: ["TURSO_DATABASE_URL"],
				// a deployment's filesystem is read-only and per-instance
				message: "a file: URL is refused while VERCEL is set",
			},
		);
}

/**
 * Parses the service's environment. Throws naming each bad variable and why,
 * never its value; an empty string counts as unset.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
	const present = Object.fromEntries(
		Object.keys(fields.shape).map((name) => [name, source[name] || undefined]),
	);
	const result = schemaFor(Boolean(source.VERCEL)).safeParse(present);
	if (result.success) {
		// An unset optional stays off the object, same as the other variables.
		if (result.data.OPENAI_APPS_CHALLENGE === undefined) {
			const { OPENAI_APPS_CHALLENGE: _unset, ...rest } = result.data;
			return rest;
		}
		return result.data;
	}
	const problems = result.error.issues.map(
		(issue) => `${issue.path.join(".")}: ${issue.message}`,
	);
	throw new Error(`Invalid environment:\n${problems.join("\n")}`);
}

export const env: Env = parseEnv(process.env);
