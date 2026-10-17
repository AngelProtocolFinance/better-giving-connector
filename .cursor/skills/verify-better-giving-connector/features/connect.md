# Connect

Connect lets an operator sign the chat app into one Better Giving donation site. The address page takes the site address, Allow on that site returns the operator to the chat app, and `/mcp` then speaks as that organization.

## Sub-features

- `connect-discover` reads the OAuth metadata the chat app fetches before register.
- `connect-address` shows the address page and accepts `give.example.org`.
- `connect-allow` sends the browser to the donation site's Allow screen and back to `/connect/return`.
- `connect-token` trades the authorization code for tokens and opens `/mcp` with instructions that name the organization.

## How to get to it (user POV)

- In the chat app, add the connector at `http://localhost:3000/mcp` (production is `https://app.connect.better.giving/mcp`, as `/docs` states).
- The chat app opens the authorize URL. The browser lands on `/connect`.
- Submit `Your Better Giving address` with Continue, press Allow on the donation site, and land back in the chat app.

## Driving it with verify-better-giving-connector

Preconditions:

- `doctor.sh` printed `doctor ok` for this launch.
- The fake answers `https://give.example.org/connector/v1/hello` with service `better-giving`.
- No earlier `drive.sh` in this launch has to have connected; connecting again registers another client and another connection.

- **Discover.** The chat app reads protected-resource and authorization-server metadata. Run `.cursor/skills/verify-better-giving-connector/scripts/drive.sh connect`. The transcript contains `GET /.well-known/oauth-protected-resource -> 200` and `GET /.well-known/oauth-authorization-server/api/auth -> 200`.
- **Register.** The chat app registers a public client for `https://claude.ai/api/mcp/auth_callback`. The same command's transcript contains `POST /api/auth/oauth2/register -> 200` or `-> 201`.
- **Open the address page.** The authorize URL leads to `/connect`. The transcript contains `GET /api/auth/oauth2/authorize -> 200`, `json-redirect path=/connect`, `GET /connect -> 200`, and `address page title=Connect Better Giving button=Continue`.
- **Submit the address.** Continue posts `address=give.example.org`. The transcript contains `POST /connect -> 302` and `allow host=give.example.org path=/admin/connector/allow`.
- **Press Allow.** The donation site redirects to `/connect/return` on the production connector host. The drive requests that path and query on `http://localhost:3000` with the connect cookie. The transcript contains `GET give.example.org/admin/connector/allow -> 302` and `GET /connect/return -> 302` with `return host=claude.ai path=/api/mcp/auth_callback has-code=yes`.
- **Exchange the code.** The chat app posts the code to the token endpoint and does not follow the callback. The transcript contains `POST /api/auth/oauth2/token -> 200` and `connect ok`.
- **Proof.** `verify-evidence/<run-id>/connect/instructions.txt` contains `Hope Shelter`, and the transcript contains `initialize instructions-contain-Hope Shelter=yes`. The access token is only in the scratch `session.json`.

## Gotchas

- `localhost`, an IP address, and a URL with a port are refused on the address form. The local fake's address is `give.example.org`.
- Allow's `Location` is `https://app.connect.better.giving/connect/return`. The drive repeats the path and query against `http://localhost:3000`. Following that production URL leaves this instance.
- The address form is a same-origin POST. A client that omits `Origin: http://localhost:3000` gets the cross-site page.
- The signed login request on `/connect` expires 10 minutes after the chat app opened authorize. A slow run shows `Connection request timed out`.
- `__Secure-connect` is the state cookie. The drive stores the name and value and sends them on `/connect/return`. Browsers keep it because `http://localhost` is a secure context.
- Node `fetch` cannot send `sec-fetch-mode: navigate`; undici sets `cors`. better-auth then returns the authorize hop as JSON `redirect` + `url` with status 200. A browser on the same URL gets 302. Both open `/connect` with the same signed query. The transcript's `json-redirect` line is that hop.
- Evidence must not contain the authorization code, the access token, or the cookie value.
