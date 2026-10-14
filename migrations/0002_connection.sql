-- key_ct is sealed by src/db/key-cipher.ts. No FK to better-auth's user table:
-- whoever deletes a user deletes its connection row first.
CREATE TABLE connection (
	user_id TEXT PRIMARY KEY NOT NULL,
	origin TEXT NOT NULL,
	org_name TEXT NOT NULL,
	key_ct TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;
