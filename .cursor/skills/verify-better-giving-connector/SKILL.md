---
name: verify-better-giving-connector
description: Drive the Better Giving connector the way an operator does — the local HTTP app, the /connect OAuth flow, MCP tools at /mcp, the public docs pages, and the fake donation site — and capture proof. Use when a change to connect, tools, public pages, or donation-site calls needs evidence from the running app.
---

# Verify the Better Giving connector

The connector is the local service operators reach from Claude or ChatGPT. A chat app completes OAuth, then calls tools on `POST /mcp`. Each tool calls the connected donation site at `/connector/v1`. This skill runs that path on one local instance: `pnpm dev` plus the fake donation site from `test/fake-deployment.ts`.

Run every command from the repo root. Drive only the instance `launch.sh` started.

One instance owns port 3000 and port 443. A second `launch.sh` refuses while `/tmp/bgc-verify-active` exists. Two connectors can otherwise use two `PUBLIC_URL` ports and two `file:` databases; they cannot share `https://give.example.org` on port 443.

## Launch

Requires Node 24 (`.nvmrc`) and installed dependencies. If `node_modules/.bin/tsx` is missing:

```bash
pnpm install --frozen-lockfile
```

Start from an empty data directory (no seed rows in the connector database; `pnpm dev` applies `migrations/*.sql` before it listens):

```bash
.cursor/skills/verify-better-giving-connector/scripts/launch.sh
```

What that script does:

- Creates `/tmp/bgc-verify-<run-id>/` and a `file:` database at `local.db` inside it. Nothing is copied from an older database.
- Writes throwaway 32+ character values for `BETTER_AUTH_SECRET`, `CONNECTION_KEY_SECRET`, and `CRON_SECRET` into the connector process only.
- Sets `PUBLIC_URL=http://localhost:3000` and `TURSO_DATABASE_URL=file:/tmp/bgc-verify-<run-id>/local.db`. `pnpm dev` refuses a non-`file:` URL and a `PUBLIC_URL` with no port. An existing `.env.local` fills only names the process left unset; `VERCEL` in that file makes `pnpm dev` refuse the file database, and launch stops.
- Generates a local CA and a certificate for `give.example.org`, and adds `127.0.0.1 give.example.org` to `/etc/hosts` when that name is absent. The connector accepts a donation-site address only as public `https` with no port (`parseOrigin` in `src/deployment/origin.ts`), so the fake listens on `127.0.0.1:443`. Binding 443 uses `sudo -n`.
- Starts the fake in tmux session `bgc-verify-fake-<run-id>` via `scripts/fake-server.ts`. The process serves `fakeDeployment({ host: "give.example.org", name: "Hope Shelter" })` from `test/fake-deployment.ts`. Its ready line is `fake ready org=Hope Shelter`. The fake seeds donation form `frm_1` and a starting donation page in memory. The connector database has no connection row until OAuth finishes.
- Starts the connector in tmux session `bgc-verify-connector-<run-id>` with `pnpm dev` (`tsx watch --import ./scripts/mp4-register.mjs --env-file-if-exists=.env.local src/dev.ts`) and `NODE_EXTRA_CA_CERTS` pointing at the run CA. `src/dev.ts` prints no listen line.

Ready (both, and the migration check) — `pnpm dev` has finished `migrate()` before `listen`:

- `GET http://localhost:3000/docs` is 200 and contains `Documentation — Better Giving Connector`.
- `GET https://give.example.org/connector/v1/hello` (trust the run CA) is 200 and contains `"service":"better-giving"` and `"contract":1`.
- `schema_migration` in the new database lists `0001_better_auth.sql,0002_connection.sql`.

Launch prints `ready public=http://localhost:3000 fake=https://give.example.org evidence=verify-evidence/<run-id>`. A failed launch runs cleanup for that attempt.

Teardown is `scripts/cleanup.sh` in Cleanup below.

## Doctor

Read-only. Run this before the first drive and again after anything surprising. It does not create a connection or call a tool.

```bash
.cursor/skills/verify-better-giving-connector/scripts/doctor.sh
```

It exits 0 only when all of these hold, and appends the same lines to `verify-evidence/<run-id>/doctor.txt`:

- The connector tmux session is alive, and the process listening on port 3000 is the pid launch recorded, with `src/dev.ts` or `tsx` in its command line.
- The fake pid launch recorded is alive.
- `GET /docs` is the documentation page above.
- `GET https://give.example.org/connector/v1/hello` returns service `better-giving`, contract `1`.
- `GET http://localhost:3000/.well-known/oauth-protected-resource` returns `"resource":"http://localhost:3000/mcp"`.
- `schema_migration` is still `0001_better_auth.sql,0002_connection.sql`.

`src/dev.ts` has no build stamp. The docs title, Node's version, and package name `better-giving-connector` are the identity doctor records. A passing doctor ends with `doctor ok`.

## Drive

The harness is HTTP against the launched processes, using the same chat-app steps as `test/oauth.ts` and `test/operator.ts` and the same fake routes as `test/fake-deployment.ts`.

```bash
.cursor/skills/verify-better-giving-connector/scripts/drive.sh <feature>
```

`<feature>` is one of `connect`, `record-donation`, `create-campaign`, `read-tools`, `public-pages`. `drive.sh` sets `NODE_EXTRA_CA_CERTS` to the run CA, then runs `pnpm exec tsx .cursor/skills/verify-better-giving-connector/scripts/drive.ts <feature>`.

Run doctor first. Run one feature from a fresh launch when its file says the fake starts empty. A later feature in the same launch sees donations and campaigns the earlier feature inserted.

### OAuth connect

`drive.sh connect` and the other tool features (when no session file exists yet) walk the operator path:

1. `GET /.well-known/oauth-protected-resource`, then `GET /.well-known/oauth-authorization-server/api/auth`.
2. `POST /api/auth/oauth2/register` with Claude's redirect `https://claude.ai/api/mcp/auth_callback`, public client, PKCE S256. Status 200 or 201.
3. `GET /api/auth/oauth2/authorize` is the chat app opening sign-in. A browser sends `sec-fetch-mode: navigate` and receives 302 to `/connect`. Node's `fetch` sends `sec-fetch-mode: cors`, and better-auth answers 200 `{"redirect":true,"url":"/connect?..."}`. The drive follows that `url` onto the same `/connect` request.
4. `GET /connect` is the address page: title `Connect Better Giving`, button `Continue`, field `address`.
5. `POST /connect` as a same-origin form (`Origin: http://localhost:3000`, body `address=give.example.org`) returns 302 to `https://give.example.org/admin/connector/allow` and sets the `__Secure-connect` cookie. The drive sends that cookie back itself.
6. `GET /admin/connector/allow` on the fake returns 302 to `https://app.connect.better.giving/connect/return` (`RETURN_URL` in `test/fake-deployment.ts`) with `code`, `state`, and `iss`. The drive then requests that path and query on `http://localhost:3000`, with the connect cookie. That is the same rewrite as `returnTo` in `test/operator.ts`.
7. `GET /connect/return` returns 302 to `https://claude.ai/api/mcp/auth_callback` with a `code`. The drive does not follow that URL.
8. `POST /api/auth/oauth2/token` with the authorization code and PKCE verifier returns 200. The access token stays in `/tmp/bgc-verify-<run-id>/session.json` (mode 0600). Evidence does not contain it.
9. `POST /mcp` method `initialize`, protocol `2025-06-18`, client `chat-app`. `result.instructions` contains `Hope Shelter`.

Tool calls are `POST /mcp` JSON-RPC `tools/call` with `Authorization: Bearer <access token>`, `accept: application/json, text/event-stream`, and `mcp-protocol-version: 2025-06-18`. A body may be one JSON object or one SSE `data:` event. The 23 tool names are the `tool` fields in `src/mcp/actions.ts`.

### record_donation

`drive.sh record-donation` connects, then calls `record_donation` twice with the same arguments. The donation site answers the first `POST /connector/v1/donations` with 201 and the second with 200. The second tool text starts with:

```text
Already done: this matches an earlier call with the same details, so nothing new was recorded. The original result follows.
```

`list_donations` then shows one gift with that note. The same call with a different `note` is a new gift (another 201). The connector derives `Idempotency-Key` from the user id, the action, and the canonical arguments (`src/deployment/idempotency.ts`), so a normal tool call does not send a conflicting key.

The 409 is on the donation site. The drive presses Allow, `POST /connector/v1/exchange`s the code, then `POST /connector/v1/donations` three times with one `Idempotency-Key`: same body (201), same body again (200, same gift id), different body (409 `idempotency_conflict`). `list_donations` still shows one gift for the clashing note. The evidence records statuses and those bodies, not the key, the connection key, or the OAuth token.

### Other features

Recipes and proof lines are in `features/`. `create-campaign` checks draft creation and the same replay sentence. `read-tools` calls the read tools. `public-pages` fetches `/docs`, `/support`, `/privacy`, and `/terms`.

### Real donation site (`LIVE_ORIGIN` / `LIVE_CODE`)

Do not point this local drive at a real site. `LIVE_ORIGIN` and `LIVE_CODE` are not read by `pnpm dev` or by `drive.sh`.

To exercise a real deployment (Platform staging when those values exist), put them in the environment or in a git-ignored `.env.live`, then from the repo root:

```bash
pnpm test:live
```

`test/live/env.ts` reads `LIVE_ORIGIN` and `LIVE_CODE`, and `.env.live` fills either name the environment left unset. Both are required. `LIVE_ORIGIN` is the deployment's `https` origin with no path. `LIVE_CODE` is one single-use Allow code from that deployment. The live harness exchanges the code, runs the 13 minimum tools (`create_campaign` and `record_donation` twice each; the second call's outcome is `replay`), expects the other 10 tools to be actions that deployment does not serve, disconnects, and expects the next call to be `key_refused`. It writes `test/live/results.ndjson` with `tool`, `outcome`, `ms`, and `bytes` only. It does not write arguments, response bodies, or the connection key. That file is gitignored.

Leave `LIVE_ORIGIN` and `LIVE_CODE` unset when they have not been provided. A real site's Allow screen returns the browser to `https://app.connect.better.giving/connect/return`, which is that deployment's production connector, so the local return rewrite above does not apply.

## Evidence

Write proof under `verify-evidence/<run-id>/` at the repo root. Cleanup never deletes that directory. It is gitignored because a transcript must not be committed with a token in it.

Each feature directory holds `transcript.txt` plus the response bodies named in the feature file. Also keep:

- `verify-evidence/<run-id>/launch.txt` — ready signals.
- `verify-evidence/<run-id>/doctor.txt` — the doctor lines.

Capture the action and the resulting state. For a tool, that is the tool text and the donation-site status line (`deployment=201` or `deployment=200`) from `deployment.ndjson` in the scratch dir (method, path, status only). For a page, that is the HTTP status, the `<title>`, and one sentence from the page. For connect, that is each hop's status and path, then `instructions.txt`.

Check side effects on the donation site, not only the tool sentence. After a replay, `list_donations` or `list_campaigns` shows the original row once. The 409 body is `clash-409.json` and the following list still has one row for that note.

The fake is the donation site the tests already use. It is the stand-in for a Better Giving deployment, which is the production boundary. Do not mock `/mcp` or `/connect`.

Before saving a body, the drive replaces `bgk_…` connection keys, `Bearer` tokens, token JSON fields, and the `__Secure-connect` cookie value with `[redacted]`. Do not copy `session.json`, `run.env`'s sibling secret-bearing process environment, or `/tmp/bgc-verify-<run-id>/` into the evidence directory. `run.env` itself has paths and ports only.

## Cleanup

```bash
.cursor/skills/verify-better-giving-connector/scripts/cleanup.sh
```

This stops the two tmux sessions named in the active run file and, if those pids are still alive, signals the connector pid and the fake pid recorded at launch. It removes the `/etc/hosts` line only when this launch added one (the line's comment is `# bgc-verify-<run-id>`). It deletes `/tmp/bgc-verify-<run-id>/` (database, CA, private keys, `session.json`) and `/tmp/bgc-verify-active`.

It leaves `verify-evidence/<run-id>/` in place. Confirm a proof file is still there after cleanup before calling the run done.

Run cleanup after a failed drive too, so the ports and the hosts line do not linger. If port 3000 or 443 is held by a pid this launch did not record, stop and leave that process alone.

## Helpers

All of these are executable. Paths are from the repo root.

| Helper | Invocation |
| --- | --- |
| Launch | `.cursor/skills/verify-better-giving-connector/scripts/launch.sh` |
| Doctor | `.cursor/skills/verify-better-giving-connector/scripts/doctor.sh` |
| Drive | `.cursor/skills/verify-better-giving-connector/scripts/drive.sh record-donation` |
| Cleanup | `.cursor/skills/verify-better-giving-connector/scripts/cleanup.sh` |

`drive.sh` is the drive entry point. It execs `pnpm exec tsx .cursor/skills/verify-better-giving-connector/scripts/drive.ts` with the run CA in `NODE_EXTRA_CA_CERTS`. `scripts/fake-server.ts` is started by `launch.sh`, not by hand: `sudo -n` node, `VERIFY_RUN` set to the scratch directory, listening on `127.0.0.1:443`. `scripts/lib.sh` is sourced by the shell helpers for the repo root, the tmux binary, and `/tmp/bgc-verify-active`.

When the app changes, run `/maintain-verification-skill` to keep this map honest.
