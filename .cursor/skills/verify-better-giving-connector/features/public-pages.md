# Public pages

Public pages are the documents an operator opens in a browser before connecting: documentation, support, the privacy policy, and the terms of service. They do not require a connection.

## Sub-features

- `page-docs` serves `/docs` with the connector's address, the demo, and what the tools can do.
- `page-support` serves `/support` with the support contact.
- `page-privacy` serves `/privacy`.
- `page-terms` serves `/terms`.

## How to get to it (user POV)

- Open `http://localhost:3000/docs`, `/support`, `/privacy`, or `/terms`.
- Each page's nav links to the other three: Docs, Support, Privacy, Terms.
- `/docs` states the production server URL `https://app.connect.better.giving/mcp`.

## Driving it with verify-better-giving-connector

Preconditions:

- `doctor.sh` printed `doctor ok` for this launch.
- No connection and no fake row is required. The command does not call `/mcp`.

- **Open the docs.** Run `.cursor/skills/verify-better-giving-connector/scripts/drive.sh public-pages`. The transcript contains `GET /docs -> 200 title=yes sentence=yes`. `docs.html` has `<title>Documentation — Better Giving Connector</title>` and `The Better Giving Connector lets a nonprofit`.
- **Open support.** The transcript contains `GET /support -> 200 title=yes sentence=yes`. `support.html` has `<title>Support — Better Giving Connector</title>` and `support@better.giving`.
- **Open the privacy policy.** The transcript contains `GET /privacy -> 200 title=yes sentence=yes`. `privacy.html` has `<title>Privacy Policy — Better Giving Connector</title>`.
- **Open the terms.** The transcript contains `GET /terms -> 200 title=yes sentence=yes`. `terms.html` has `<title>Terms of Service — Better Giving Connector</title>` and `These Terms govern your use of the Better Giving Connector`.
- **Proof.** The transcript contains `GET / -> 404` and `public-pages ok`. The four HTML files are under `verify-evidence/<run-id>/public-pages/`.

## Gotchas

- `GET /` is 404. The pages above are the site. Do not treat a 404 at `/` as a failed launch; doctor uses `/docs`.
- `/.well-known/openai-apps-challenge` is 404 while `OPENAI_APPS_CHALLENGE` is unset. Launch leaves it unset.
- The pages link to `https://app.connect.better.giving/mcp`. That host is the production connector. This local run is `http://localhost:3000`.
- Saving the HTML is safe: these responses carry no connection key and no OAuth token.
