// The config `npx auth@1.7.7 generate --config src/auth/cli.config.ts` reads:
// better-auth's options over a fresh database holding every migration, so the
// SQL it prints is the next migration (empty when migrations/ is current).
import { betterAuth } from "better-auth";
import { createDb, migrate } from "../db/index.ts";
import { authOptions } from "./options.ts";

const db = createDb({ url: ":memory:" });
await migrate(db);

export const auth = betterAuth(
  authOptions({
    db,
    publicUrl: "http://localhost:8787",
    // generation signs nothing
    secret: "schema-generation-only-0123456789abcdef",
  }),
);
