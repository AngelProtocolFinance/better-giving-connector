# `/connector/v1` — the contract this service speaks

**Status: draft, written from the connector side.** `better-giving-oss` owns and versions this
surface (its `plan/connector/brief.md`, PR 2) and has not built it yet. This file is what the
connector is coded and tested against (`src/fake-deployment/`); when the deployment ships the
surface, the deployment's own definition wins and this file follows it.

The connector reaches a deployment through this surface and nothing else.

## Conventions

Taken from the deployment's existing `/integrations/v1` so both surfaces read alike.

- **Base:** `<deployment origin>/connector/v1`. JSON in and out, snake_case, ISO-8601 times,
  money as integer minor units (`*_minor`) plus a 3-letter `currency`.
- **Key:** `Authorization: Bearer <key>` on every action. A connector key is its own kind
  (`bgc_` + 43 base62 characters), minted only by the Allow screen, refused on every other
  surface. No CORS: server to server only.
- **Refusals:** `{ "error": "<code>", "message": "<sentence>", "fix": "<sentence>" }`, `no-store`.
  4xx `message`/`fix` name the value and where to fix it; the connector shows them to the chat
  as-is. Codes are added, never renamed.
- **Lists:** keyset paging, `?limit` (default 50, max 100, larger refused) and `?cursor`;
  answer `{ "data": [...], "next_cursor": string | null }`.
- **Writes are versioned:** every page and form carries `version` (its `updated_at`). A write
  sends the `version` it read; a moved version answers `409 stale`, and the chat re-reads.
- **Every answer is `no-store`.**

### Codes the connector acts on

| Status · code | What the connector does |
|---|---|
| `401 unknown_key` · `401 revoked_key` · `401 missing_key` | the key is refused: drop the connection row, tell the chat to reconnect |
| `404 unknown_route` | the deployment's release lacks the action: tell the chat to update Better Giving |
| `409 stale` | tell the chat the page changed since it was read; re-read and retry |
| `429 rate_limited` | pass on, with `retry-after` |
| any other 4xx | pass `message` and `fix` to the chat |
| 5xx / network | "Better Giving didn't answer"; nothing dropped |

## Handshake

### `GET /connector/v1/hello` — no key

```json
{ "service": "better-giving", "contract": "v1", "revision": 1, "release": "1.4.0", "org_name": "Hope Shelter" }
```

`revision` is an integer raised each time actions are added. The connector requires
`revision >= 1` (each tool names the revision it needs). A `404` on hello, or a lower revision,
reads as "update Better Giving". `release` is the deployment's build version or `null`.

### Allow — a browser page on the deployment

The connector sends the operator's browser to:

```
<origin>/connector/allow?return_to=https://connect.better.giving/connect/return&state=<opaque>&code_challenge=<b64url sha256>&code_challenge_method=S256
```

- The deployment accepts only that `return_to`, written in its code; any other is refused
  without redirecting.
- It requires the dashboard sign-in (returning to this URL after login), then shows what the
  connection can do, donor names and emails included, with Allow and Cancel, and says: only
  press Allow if you pressed Connect in your chat app in the last few minutes; if someone sent
  you this link, press Cancel.
- Allow and Cancel are a `POST` with the dashboard's CSRF check; a `GET` never allows. The page
  sends `frame-ancestors 'none'`.
- **Allow** mints a connector key, inactive until exchanged, and a single-use code (5 minutes)
  bound to the `code_challenge`, then `303` to
  `return_to?code=<code>&state=<state>&iss=<deployment origin>`. A key whose code expires
  unexchanged is revoked.
- **Cancel** `303`s to `return_to?error=access_denied&state=<state>&iss=<deployment origin>`.
- `iss` is the deployment's own origin (RFC 9207). The connector refuses a return whose `iss`
  isn't the origin it sent the operator to, before any exchange, so a code can't be steered to
  another site's exchange.

### `POST /connector/v1/exchange` — no key

Request `{ "code": "...", "code_verifier": "..." }` → `200 { "key": "bgc_...", "org_name": "..." }`,
exactly once. A used, expired or unknown code, or a verifier that doesn't match, is
`400 invalid_code`.

The key never leaves the connector after this answer.

### `POST /connector/v1/disconnect` — key

Revokes the presented key → `204`. The connector calls it when a connect attempt fails after the
exchange, so no key outlives a connection that never formed. The dashboard's Disconnect does the
same from the other side.

## Actions

All need the key. `rev` is the hello revision that carries the action.

### Campaigns and the donation page

| Method · path | Body | Answer |
|---|---|---|
| `GET /campaigns` | — | list of `CampaignSummary` |
| `GET /campaigns/:id` | — | `Campaign` |
| `POST /campaigns` | `{ name, campaign_type }` | `Campaign` (state `never_published`) |
| `PATCH /campaigns/:id` | `{ version, name?, slug? }` | `Campaign` |
| `PUT /campaigns/:id/draft` | `{ version, document }` | `Campaign` |
| `POST /campaigns/:id/discard-draft` | `{ version }` | `Campaign` |
| `POST /campaigns/:id/publish` | `{ version, gifts_go_to? }` | `Campaign` |
| `POST /campaigns/:id/unpublish` | `{ version }` | `Campaign` |
| `POST /campaigns/:id/end` | `{ version }` | `Campaign` |
| `DELETE /campaigns/:id` | `{ version }` | `204`; never-published campaigns only |
| `GET /donation-page` | — | `DonationPage` |
| `PUT /donation-page/draft` | `{ version, document }` | `DonationPage` |
| `POST /donation-page/publish` | `{ version }` | `DonationPage` |
| `POST /donation-page/reset` | `{ version }` | `DonationPage` |

- `CampaignSummary`: `id, name, slug, url, state, campaign_type, goal_minor, ends_at, raised_minor, currency, version`.
- `Campaign`: the summary plus `editor_state` (`unpublished | changed | live | ended`),
  `draft` and `published` (page documents, `published` null before first publish).
- `DonationPage`: `url, editor_state, draft, published, version`.
- `campaign_type`: `year_end | emergency | building | event | tribute | monthly | program | other`.
- `state`: `never_published | live | ended`.
- `document`: the deployment's page document (`lib/page/catalog.ts` → `parsePage`): `layout`,
  `palette`, `look`, `share_message`, `share_channels`, `switches`, campaign `name`, `goal_minor`,
  `ends_at` + `ends_zone`, and `blocks` (`title`, `story`, `impact-tiers`, `faq`, `about-us`,
  `org-info`, `share`, `hero`, `image`, `goal-bar`, `program-chooser`, exactly one
  `donation-box`). Validated by the same rules a hand edit meets; a refusal's `message` names the
  field path. `GET /page-catalog` returns the catalog as JSON Schema so the chat can build one.
- `gifts_go_to`: a program id, or `null` for the general fund; required on a campaign's first
  publish only.
- `unpublish`: takes the campaign off its public address so it stops taking gifts; the draft stays.
  Its `state` reads `never_published` again (it can be published anew), but `DELETE` stays
  refused (`409 was_published`) because it took gifts once.
- `POST /donation-page/reset`: replaces the donation page, live and draft, with the default
  starting page; its gift settings stay. `POST /campaigns` answers `201`.

### Forms, programs, catalog

| Method · path | Body | Answer |
|---|---|---|
| `GET /forms` | — | list of `Form` |
| `GET /forms/:id` | — | `Form` |
| `POST /forms` | `{ name, suggested_amounts_minor?, min_minor?, max_minor?, program_mode?, program_id?, allowed_origins? }` | `Form` |
| `PATCH /forms/:id` | `{ version, ...any create field }` | `Form` |
| `POST /forms/:id/archive` | `{ version }` | `Form` |
| `GET /programs` | — | list of `{ id, name, description, status }` |
| `GET /page-catalog` | — | JSON Schema of `document` |

`Form`: `id` (`frm_…`), `name, status (draft | live | archived), suggested_amounts_minor,
min_minor, max_minor, currency, program_mode (none | pinned | choice), program_id,
allowed_origins, owned_by_page_id, embed_url, version`. A page-owned form is read-only here
(`409 owned_by_page`).

### Reads

| Method · path | Query | Answer |
|---|---|---|
| `GET /results` | `from`, `to` (dates) | `{ raised_minor, gifts, donors_new, recurring_active, by_month: [{ month, raised_minor, gifts }], currency }` |
| `GET /campaigns/:id/results` | — | `{ raised_minor, goal_minor, gifts, currency }` |
| `GET /gifts` | `limit, cursor, form_id?, since?` | list of `Gift` (the `/integrations/v1` `ApiGift` shape) |
| `GET /donors` | `limit, cursor, q?` | list of `Donor` (`ApiDonor` shape) |
| `GET /donors/:id` | — | `Donor` plus `gifts_count`, `given_minor`, `last_gift_at` |
| `GET /recurring-gifts` | `limit, cursor` | list of `RecurringGift` (`ApiRecurringGift` shape) — read only |

### Writes outside pages

| Method · path | Body | Answer |
|---|---|---|
| `POST /gifts` | `{ idempotency_key, donor: { id } \| { new: { name, email?, kind? } }, amount_minor, dated, method: "cash" \| "check", program_id?, form_id?, note? }` | `201 Gift`; a repeated `idempotency_key` answers the first gift with `200` |
| `POST /photo-links` | `{ target: "campaign" \| "donation_page", page_id?, block_id }` | `{ url, expires_at }` |

A photo link opens a deployment page that needs no sign-in, takes one image (the dashboard's
own limits), puts it into that block of the draft, and is refused after first use or after 30
minutes. The chat hands the URL to the operator; the image never passes through the connector.

### Not on this surface

Refunds, changing or stopping a donor's monthly gift, and anything the console holds (processor
keys, legal identity, mission, logo, Cloudflare). No route exists for them.
