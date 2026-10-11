-- A client some connection was completed through: a chat app may hold its
-- client_id for good, so the sweep never deletes it. Not in better-auth's
-- oauthClient, which its CLI regenerates.
CREATE TABLE used_client (
	client_id TEXT PRIMARY KEY NOT NULL
) STRICT;
