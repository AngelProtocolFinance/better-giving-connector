-- A connect attempt between sending the operator's browser to the deployment's
-- allow page and its redirect back, keyed by the `state` that round-trips.
-- The return consumes it once; an abandoned one stays until swept, a grace period after expiry.
CREATE TABLE pending_connect (
  state TEXT PRIMARY KEY,
  -- the chat app's signed oauth query, to resume its authorization
  oauth_query TEXT NOT NULL,
  -- the PKCE verifier for the code the deployment returns
  code_verifier TEXT NOT NULL,
  deployment_url TEXT NOT NULL,
  -- the release the deployment's hello reported; empty when it reported null
  deployment_release TEXT NOT NULL,
  -- written only as Date.toISOString() (src/db/pending-connects.ts), so text order is time order
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
) STRICT;
