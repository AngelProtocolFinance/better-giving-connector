import { z } from "zod";

/** A signing secret of any shape; `openssl rand -base64 32` prints 44 characters. */
const secret = z.string().min(32);

/** The AES-256 key itself: 32 bytes, base64. `keyCipher` (src/db/crypto.ts) refuses any other length. */
const aesKey = z
  .base64()
  .refine((value) => Buffer.from(value, "base64").byteLength === 32);

const EnvSchema = z.object({
  PUBLIC_URL: z.url(),
  TURSO_DATABASE_URL: z.string().min(1),
  TURSO_AUTH_TOKEN: z.string().optional(),
  BETTER_AUTH_SECRET: secret,
  CONNECTION_KEY_SECRET: aesKey,
});

export type Env = z.infer<typeof EnvSchema>;

/** An in-process database: the only kind reached without a token. */
export function isLocalDatabase(databaseUrl: string | undefined): boolean {
  return (
    databaseUrl === ":memory:" || databaseUrl?.startsWith("file:") === true
  );
}

/** The app's env from `source`; throws naming every var it can't serve without, never a value. */
export function parseEnv(
  source: Readonly<Record<string, string | undefined>>,
): Env {
  // a dashboard or an env file can hold an empty value: it reads as unset
  const set = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== ""),
  );
  const parsed = EnvSchema.safeParse(set);
  // names only, never issue messages: a custom one can quote the value it rejected
  const invalid = new Set(
    parsed.error?.issues.map((issue) => String(issue.path[0])),
  );
  if (
    !isLocalDatabase(set.TURSO_DATABASE_URL) &&
    set.TURSO_AUTH_TOKEN === undefined
  ) {
    invalid.add("TURSO_AUTH_TOKEN");
  }
  if (parsed.success && invalid.size === 0) return parsed.data;
  // biome-ignore lint/plugin: interpolates variable names only, never their values
  throw new Error(
    `Missing or invalid environment variables: ${[...invalid].join(", ")}.`,
  );
}
