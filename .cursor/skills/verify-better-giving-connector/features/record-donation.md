# Record a donation

Record a donation lets the operator enter a gift already received in cash or by check. The same details again match the earlier gift. A distinguishing note records a second gift. The tool moves no money.

## Sub-features

- `record-first` records one cash gift and the donation site answers 201.
- `record-replay` sends the same arguments again; the donation site answers 200 and the tool says the gift was already recorded.
- `record-listed` shows that one gift from `list_donations`.
- `record-note` records another gift when the note differs.
- `record-conflict` shows Idempotency-Key behavior on `POST /connector/v1/donations`: 201, then 200, then 409 `idempotency_conflict`.

## How to get to it (user POV)

- Finish Connect, then ask the chat app to record an offline cash or check gift.
- The chat app calls `record_donation` on `POST /mcp` with `amount` (`amount`, `currency` `USD`), `date`, `donor.name`, optional `donor.email`, `method` `cash` or `check`, and optional `note`.
- Ask for the gift list. The chat app calls `list_donations`.

## Driving it with verify-better-giving-connector

Preconditions:

- `doctor.sh` printed `doctor ok` for this launch.
- The fake is up at `https://give.example.org`. A fresh launch has no donations; this command creates the ones it asserts on, using a note unique to the invocation.
- The command connects first when scratch `session.json` is absent.

- **Connect.** Run `.cursor/skills/verify-better-giving-connector/scripts/drive.sh record-donation`. The transcript reaches `connect ok`, and `verify-evidence/<run-id>/record-donation/instructions.txt` contains `Hope Shelter`.
- **Record the gift.** The same command calls `record_donation` for a cash gift dated today with donor `Verify Donor`. The transcript contains `record-first deployment=201`, and `record-first.txt` is JSON with that note, `"method":"cash"`, and an `id`.
- **Replay the gift.** The same arguments are sent again. The transcript contains `record-replay deployment=200 same-id=yes`. `record-replay.txt` starts with `Already done: this matches an earlier call with the same details, so nothing new was recorded. The original result follows.` and the JSON after that sentence has the same `id`.
- **Confirm one row.** `list-after-replay.json` is `list_donations`. The transcript contains `list-after-replay note-count=1`.
- **Record a second gift with a note.** The same command sends the gift again with a different note. The transcript contains `record-second deployment=201 new-gift=yes`. `record-second.txt` is JSON for the new note and a different `id`, and it does not start with the already-done sentence.
- **Conflict the key on the donation site.** The same command presses Allow, exchanges the code, and posts one gift body twice and then a different body, under one Idempotency-Key, to `POST /connector/v1/donations`. The transcript contains `clash http=201,200,409 logged=201,200,409`. `clash-201.json` and `clash-200.json` share an `id`. `clash-409.json` has `"code":"idempotency_conflict"`. `list-after-clash.json` still has one donation with the clash note (`list-after-clash clash-note-count=1`).
- **Proof.** The command prints `record-donation ok evidence=verify-evidence/<run-id>/record-donation`. That directory still exists after `cleanup.sh`.

## Gotchas

- A second `drive.sh record-donation` in the same launch uses a new note, so its own first call is still 201. The replay inside one command is what proves the duplicate.
- The chat tool does not take an Idempotency-Key. Identical arguments replay. Changing the note is a new gift, not a 409. The 409 is the donation site answering the same key with a different body.
- `record_donation` rejects a `campaign_id`. The gift is not tied to a campaign. Currency is `USD`.
- The clash posts must not copy the connection key, the OAuth token, or the Idempotency-Key value into the evidence. Statuses and the problem body are the proof.
- `pnpm test:live` is the path that records a gift on a real deployment when `LIVE_ORIGIN` and `LIVE_CODE` are set. It expects outcome `replay` for the second `record_donation` and does not record a 409. Leave it unrun until those values are provided.
