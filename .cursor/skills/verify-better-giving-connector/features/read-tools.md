# Read tools

Read tools let the operator inspect the connected donation site: campaigns, the donation page, the block catalog, forms, fundraising results, donations, donors, and monthly gifts. They do not create or change rows.

## Sub-features

- `read-list` calls `list_campaigns`, `list_forms`, `list_donations`, `list_donors`, and `list_recurring_gifts`.
- `read-page` calls `get_donation_page` and `get_block_catalog`.
- `read-results` calls `get_results`.
- `read-form` calls `get_form` with the id `list_forms` returned.
- `read-one` calls `get_campaign` or `get_donor` when that list has an id.

## How to get to it (user POV)

- Finish Connect, then ask the chat app to list campaigns, open the donation page, or show fundraising results.
- The chat app calls the matching tool on `POST /mcp`.

## Driving it with verify-better-giving-connector

Preconditions:

- `doctor.sh` printed `doctor ok` for this launch.
- The fake is the fresh `Hope Shelter` site, including form `frm_1`, or an earlier feature in this same launch has added rows you mean to read.
- `drive.sh read-tools` connects first when scratch `session.json` is absent.

- **List the tools.** Run `.cursor/skills/verify-better-giving-connector/scripts/drive.sh read-tools`. `verify-evidence/<run-id>/read-tools/tools.txt` lists `list_campaigns`, `get_campaign`, `get_donation_page`, `get_block_catalog`, `list_forms`, `get_form`, `get_results`, `list_donations`, `list_donors`, `get_donor`, and `list_recurring_gifts`.
- **Read what a fresh site can answer.** The same command writes JSON bodies for `list_campaigns`, `get_donation_page`, `get_block_catalog`, `list_forms`, `get_results`, `list_donations`, `list_donors`, and `list_recurring_gifts`. Each transcript line says `<tool> json=yes`.
- **Open the seeded form.** The transcript contains `get_form id=frm_1` and `get_form.json` is that form.
- **Open one campaign.** When `list_campaigns` has an id, the transcript contains `get_campaign id=<id>` and `get_campaign.json` is that campaign. When the list is empty, the transcript contains `get_campaign unreachable: list_campaigns returned no id` and there is no `get_campaign.json`.
- **Open one donor.** When `list_donors` has an id, the transcript contains `get_donor id=<id>`. When the list is empty, the transcript contains `get_donor unreachable: list_donors returned no id`.
- **Proof.** The command prints `read-tools ok` and the JSON files parse as objects. Empty lists are a successful read of an empty site.

## Gotchas

- A fresh fake has no campaign and no donor. Do not invent an id, and do not call `create_campaign` or `record_donation` from this recipe to manufacture one. Run Create a campaign or Record a donation first, then read again, when the one-row tools are the subject.
- `get_results` on an empty site is a totals object with a zero gift count, not an error.
- `list_recurring_gifts` on the fake is an empty page. The connector cannot change a monthly gift.
- Tool arguments and connection keys stay out of the evidence. The saved files are the tool text only.
