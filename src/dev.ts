import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { consoleSink, createLogger } from "./log.ts";

const app = createApp({ log: createLogger(consoleSink) });

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) }, (info) => {
  console.log(`connector on http://localhost:${info.port}`);
});
