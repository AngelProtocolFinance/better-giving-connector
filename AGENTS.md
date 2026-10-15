# better-giving-connector

Better Giving's connector for Claude and ChatGPT: an MCP server at `/mcp` that turns each `/connector/v1` action of a Better Giving deployment into a tool, plus the OAuth connect flow those chat apps start.

Production origin: `https://app.connect.better.giving` (Vercel, fluid, region `iad1`, daily cron `GET /cron/sweep`). `connect.better.giving` is a mail-only domain and must not be used as this service's host, in `PUBLIC_URL`, or in docs.

The repo is public. Secrets live only in Vercel environment variables or ignored `.env.*` files. `.gitignore` is what keeps them out of git; `.env.example` holds names only.

## Stack

Node 24 (`.nvmrc`, `engines` `24.x`), pnpm 12.4.2 (`packageManager`; use no other package manager), TypeScript 7 (`tsc --noEmit`), Hono 4 with hono/jsx, `@modelcontextprotocol/server` 2, better-auth 1.7 (`oauth-provider` and `mcp`), Kysely and `@libsql/client` (Turso), zod 4, Biome 2 with GritQL plugins in `lint/`, Vitest 5, esbuild. Exact versions are pinned in `package.json` (`savePrefix: ""` in `pnpm-workspace.yaml`).

## Commands

Run from the repo root. These match `.github/workflows/ci.yml`:

- Install: `pnpm install --frozen-lockfile`
- Lint: `pnpm exec biome check .` (`pnpm lint` is the same check)
- Typecheck: `pnpm typecheck`
- Test: `pnpm test` (`vitest run`). Hermetic: in-memory libSQL and a fake deployment. No env and no network.
- Build: `pnpm build` (esbuild → `dist/index.js`)
- Bundle-load: with no environment, the bundle must throw the fail-closed env error and nothing else:

```bash
set +e
out=$(env -i PATH="$PATH" node dist/index.js 2>&1)
echo "$out" | grep -q "Invalid environment:" || { echo "$out"; echo "dist/index.js did not reach the env parse" >&2; exit 1; }
```

Also:

- Format: `pnpm format <paths>` (paths are required; the script exits if you omit them)
- Dev: `pnpm dev`, with `.env.local` copied from `.env.example` (`TURSO_DATABASE_URL=file:local.db`, `PUBLIC_URL=http://localhost:3000`, and throwaway 32+ character secrets)
- Migrate: `pnpm db:migrate` against a local `file:` database

Done means the CI checks above are all green: lint, typecheck, test, build, and bundle-load.

## Layout and boundaries

Biome enforces the import walls:

- `src/mcp/`: the only place that imports `@modelcontextprotocol/*`. `/mcp` registers one tool per `/connector/v1` action.
- `src/auth/`: the only place that imports `better-auth` or `@better-auth/*`. OAuth sign-in for Claude and ChatGPT, including dynamic client registration. Routes under `/api/auth/*`.
- `src/db/`: the only place that imports `@libsql/client`. Connection rows and the key cipher. Schema changes are new numbered files in `migrations/`.
- `src/deployment/`: the `/connector/v1` client. It imports nothing from `src/db/`, `src/auth/`, or `src/mcp/`.
- `src/connect/`: the connect-flow pages, server-rendered with hono/jsx, mounted at `/connect`.
- `src/log.ts`: the only place `console` is allowed. Each event is a closed set of fields (`kind`, and the fields that kind names). `errorName` is `err.name`, never a message.
- `src/env.ts`: the only parse of the process environment (zod, fails closed, names variables, never values).
- `src/secret.ts`: `Secret` holds a deployment's connector key. Printing, interpolating, or serializing it yields `[redacted]`; only `reveal()` reads it.
- `test/`: integration tests and the harness (`test/harness.ts`, `test/fake-deployment.ts`).

A deployment is reached only through its `/connector/v1`. `better-giving-oss` owns and versions that contract. An older release answers with "update Better Giving". A refused key answers with "reconnect" and the row is dropped.

## Conventions

- Tabs, double quotes (Biome).
- No `@ts-ignore`, no focused tests, no floating promises (Biome).
- No `!!` or `Boolean()` coercion (`lint/no-coerce-boolean.grit`).
- No branching on stage or test env in `src/` (`lint/no-stage-branching.grit`): do not compare `NODE_ENV`, `VERCEL_ENV`, or `import.meta.env.MODE` to `"test"`, `"production"`, `"preview"`, or `"development"`. Inject the difference through config.
- Do not hand-edit `pnpm-lock.yaml`. `allowBuilds` in `pnpm-workspace.yaml` stays off for esbuild; the install uses the prebuilt binary.
- A new schema is a new numbered file in `migrations/`. A shipped migration is left as it was.

## Cloud agents

`.cursor/environment.json` runs `.cursor/install.sh`: the Node version named in `.nvmrc`, then the exact `pnpm` from `packageManager` via corepack, then `pnpm install --frozen-lockfile`. Tests need no secrets and no Turso URL. This environment gets test-only values, which today means no env values at all. No production secret, production Turso URL, or Turso token belongs in the cloud agent environment or in the repo.

## Never

- Never deploy. No `vercel deploy`, and no change that publishes this service.
- Never run migrations against production Turso. `pnpm db:migrate` is for a local `file:` database only.
- Never commit secrets. `.env*` stays ignored except `.env.example`.
- Never print keys or tokens. That includes a connection key, `BETTER_AUTH_SECRET`, `CONNECTION_KEY_SECRET`, `CRON_SECRET`, and `TURSO_AUTH_TOKEN`. Env failures name the variable, never the value.
- Never add a tool that moves money. No charge, refund, or payout. `record_donation` only records a gift that was already received off the site.
- Never let a tool accept or return a connection key. The key is exchanged and stored inside the service, encrypted at rest with `CONNECTION_KEY_SECRET`. It is never logged, returned to a chat, or written into an error. Tool arguments and tool results never reach a log line. `test/no-leak.test.ts` checks this on every route and tool; never weaken that test.
- Never use `connect.better.giving` as this service's host. It is mail-only. The production origin is `https://app.connect.better.giving`.
- Never talk to a deployment by any path other than `/connector/v1`.
- Never negate `.claude/skills` or `.claude/agents` in `.gitignore`.
