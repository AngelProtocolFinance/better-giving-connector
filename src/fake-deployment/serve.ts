import { serve } from "@hono/node-server";
import { createFakeDeployment } from "./app.ts";

// `pnpm dev`'s defaults; `pnpm dev` reaches this server as any `*.localhost` host on this port
const publicUrl = process.env.PUBLIC_URL ?? "http://localhost:8787";
const port = Number(process.env.FAKE_DEPLOYMENT_PORT ?? 8788);

const fake = createFakeDeployment({
  returnTo: new URL("/connect/return", publicUrl).href,
});

serve({ fetch: fake.app.fetch, port }, (info) => {
  console.log(
    `fake deployment on http://localhost:${info.port}; type give.localhost:${info.port} as the address`,
  );
});
