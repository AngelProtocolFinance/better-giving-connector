---
name: verify
description: Run this repo's CI checks before a commit. Written by /kru:setup from the sheet's `verify` line.
---

From the repo root, run the checks listed in `AGENTS.md`: `pnpm exec biome check .`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and the bundle-load check. Those are the commands in `.github/workflows/ci.yml`. If anything is red, fix it before the commit; the commit waits.
