<!-- kru v0.148.0 · derived 2026-10-11 · /kru:setup to re-derive -->
## Team

Load **`kru:lead`** before building, reviewing, or dispatching a seat — it carries how the
team works.

One package at the repo root, the `nonprofits` stack (decided 2026-10-11 · /setup, versions from `nonprofits`' workspace catalog until this repo's own lockfile carries them):

- **api** → `kru:hono-builder` — `src/`: the `/mcp` endpoint, one tool per `/connector/v1` action, and the connect flow's pages and routes in `hono/jsx` (hono 4.13.13, `@modelcontextprotocol/server` 2.2.0)
- **auth** → `kru:better-auth-specialist` — `src/auth/`: the OAuth sign-in Claude and ChatGPT start, with dynamic client registration (better-auth 1.7.7)
- **data** → `kru:turso-specialist` — `src/db/` and `migrations/`: the connection row, and every `@libsql/client` 0.18.0 call
- **platform** → `kru:vercel-platform-engineer` — `vercel.json`, env and secrets (the key-encryption secret among them), the `connect.better.giving` domain
- **tooling** → `kru:toolchain-engineer` — `package.json` scripts, `biome.json`, `tsconfig.json` (biome 2.5.15, typescript 7, pnpm 12.4.2, node 24)
- **skills** → `kru:vitest`, `zod` — vitest 5.0.3, zod 4.6.5
- **screens** → the connect flow's address page only, server-rendered; no token file yet
- **verify** → `.claude/skills/verify/`, before each commit
- **mcp** → Vercel (claude.ai connector) for live project state; the `turso@turso` plugin (`.claude/settings.json`); context7 (`.mcp.json`)

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would
need — never a nearby seat pressed into the gap.

**The repo is public.** Secrets live only in Vercel environment variables or the ignored `.env.*` files; `.gitignore` is the only thing that checks this.

**A deployment is reached only through its `/connector/v1`** — the contract `better-giving-oss` owns and versions; an older release answers with "update Better Giving", a refused key with "reconnect" and the row dropped. A connection's key is encrypted at rest and never logged, returned to a chat, or written into an error; tool arguments and results never reach a log line either. Nothing checks this yet.
