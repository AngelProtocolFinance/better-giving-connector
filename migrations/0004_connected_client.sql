-- A registered OAuth client some connection completed through: a chat app may
-- hold its client_id for good, so the sweep never deletes it. Kept apart from
-- better-auth's oauthClient, whose shape its CLI owns.
CREATE TABLE connected_client (
  client_id TEXT PRIMARY KEY
) STRICT;
