-- One chat app's OAuth grant mapped to the one Better Giving deployment it
-- reaches. The id is minted by the store, not the engine: the key's ciphertext
-- binds it as authenticated data before the row is written (src/db/crypto.ts).
CREATE TABLE connection (
  id TEXT PRIMARY KEY,
  -- the better-auth user the grant belongs to: one user per connection
  user_id TEXT NOT NULL UNIQUE,
  deployment_url TEXT NOT NULL,
  -- the release the deployment reported at connect time
  deployment_release TEXT NOT NULL,
  key_ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
) STRICT;
