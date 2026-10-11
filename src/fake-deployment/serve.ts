import { serve } from "@hono/node-server";
import { createFakeDeployment } from "./app.ts";

// `pnpm dev`'s defaults; `pnpm dev` reaches this server as give.localhost on this port
const publicUrl = process.env.PUBLIC_URL ?? "http://localhost:8787";
const port = Number(process.env.FAKE_DEPLOYMENT_PORT ?? 8788);

const fake = createFakeDeployment({
  returnTo: new URL("/connect/return", publicUrl).href,
  // the origin `pnpm dev` knows it by, not the one it's served at
  iss: `https://give.localhost:${port}`,
});

serve({ fetch: fake.app.fetch, port }, (info) => {
  console.log(
    `fake deployment on http://localhost:${info.port}; type give.localhost:${info.port} as the address`,
  );
});
