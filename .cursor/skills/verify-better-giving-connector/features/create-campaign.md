# Create a campaign

Create a campaign lets the operator add a draft campaign. Donors cannot see a draft. Sending the same title again returns the draft that was already created.

## Sub-features

- `create-first` creates one draft and the donation site answers 201.
- `create-replay` sends the same title again; the tool says it was already created and the id matches.
- `create-listed` shows that one title from `list_campaigns`.

## How to get to it (user POV)

- Finish Connect, then ask the chat app to create a campaign with a title.
- The chat app calls `create_campaign` on `POST /mcp` with `title`.
- Ask for the campaign list. The chat app calls `list_campaigns`. The new row's status is `draft`.

## Driving it with verify-better-giving-connector

Preconditions:

- `doctor.sh` printed `doctor ok` for this launch.
- The fake is up at `https://give.example.org`. The command uses a title unique to the invocation.
- The command connects first when scratch `session.json` is absent.

- **Create the draft.** Run `.cursor/skills/verify-better-giving-connector/scripts/drive.sh create-campaign`. The transcript contains `create-first deployment=201`. `verify-evidence/<run-id>/create-campaign/create-first.txt` is JSON with that title, `"status":"draft"`, and an `id`.
- **Replay the title.** `create-replay.txt` starts with `Already done: this matches an earlier call with the same details, so nothing new was recorded. The original result follows.` and the JSON after that sentence has the same `id`.
- **Confirm one row.** `list-campaigns.json` contains the title once. The transcript contains `create-campaign draft=yes replay-same-id=yes list-count=1` and `create-campaign ok`.
- **Proof.** The command prints `create-campaign ok evidence=verify-evidence/<run-id>/create-campaign`.

## Gotchas

- A draft has no public gift page until `publish_campaign`. This recipe does not publish. Publishing asks where gifts go and waits for an explicit yes.
- The same title replays. A different title creates another draft.
- On a fresh fake, `get_campaign` has no id until this command has run. Read tools reports that as unreachable rather than borrowing this command.
- The replay sentence is the same one `record_donation` uses. The proof is still the campaign id and `list_campaigns`, not the sentence alone.
