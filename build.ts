import { build } from "esbuild";

// Vercel serves the default export of dist/server.js. npm packages stay
// external, for Vercel to trace from node_modules (the libSQL driver loads a
// native binding). The Hono preset picks up that default export only if the
// output imports from "hono", as it does while hono stays external.
await build({
  entryPoints: ["server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  logLevel: "warning",
});
