import { createApp } from "./src/app.ts";
import { parseEnv } from "./src/env.ts";
import { consoleSink, createLogger } from "./src/log.ts";

// a deployment missing a var fails on load, its log naming the var, rather than mid sign-in
parseEnv(process.env);

/** The deployed app; `build.ts` bundles this file for Vercel. */
export default createApp({ log: createLogger(consoleSink) });
