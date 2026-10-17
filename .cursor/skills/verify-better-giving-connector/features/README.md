# Better Giving connector verification map

This directory is the maintained source for verifying the user-facing behavior of the Better Giving connector. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- From the repo root, run `.cursor/skills/verify-better-giving-connector/scripts/launch.sh`.
- The connector listens at `http://localhost:3000` with a new `file:` database under `/tmp/bgc-verify-<run-id>/`.
- The fake donation site listens at `https://give.example.org` and names the organization `Hope Shelter`. It seeds form `frm_1` and a starting donation page. The connector database has no connection until OAuth completes.
- Run `.cursor/skills/verify-better-giving-connector/scripts/doctor.sh` and require `doctor ok`, including `http://localhost:3000/mcp` as the OAuth resource.
- Drive only the instance this launch started.
- A fresh launch is the baseline. A second feature in the same launch sees rows the first feature inserted.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Run `.cursor/skills/verify-better-giving-connector/scripts/drive.sh <feature>`.
- Treat every command as literal.
- The access token stays in the scratch `session.json`. Evidence records statuses, paths, and redacted bodies.
- Restore nothing by deleting evidence. Cleanup removes the scratch database and leaves `verify-evidence/<run-id>/`.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the last response.
- Connect proof is the transcript of each HTTP hop plus `instructions.txt` naming `Hope Shelter`.
- Tool proof is the tool text and the donation-site status for that call.
- Mutation proof includes a later `list_donations` or `list_campaigns` of the stored row.
- Page proof is the status, the `<title>`, and one sentence from the document.
- Record the feature directory with every artifact.
- An unreachable tool (`get_campaign` or `get_donor` on a fresh fake) is a transcript line naming the missing id, not a pass through a different tool.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-better-giving-connector` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Connect](./connect.md) covers OAuth discovery, the address page, Allow, and a connector whose instructions name the organization.
- [Read tools](./read-tools.md) covers the read-only MCP tools against the connected site.
- [Record a donation](./record-donation.md) covers `record_donation`, the replay sentence, a distinguishing note, and Idempotency-Key statuses 201, 200, and 409.
- [Create a campaign](./create-campaign.md) covers a draft from `create_campaign` and the same replay sentence.
- [Public pages](./public-pages.md) covers `/docs`, `/support`, `/privacy`, and `/terms`.
