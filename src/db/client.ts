import { type Client, createClient } from "@libsql/client";

/**
 * A client on the database at `url`: a `libsql://` Turso URL with its
 * `authToken`, or a local `file:` or `:memory:` URL, which takes none.
 */
export function createDb({
  url,
  authToken,
}: {
  url: string;
  authToken?: string | undefined;
}): Client {
  return createClient(authToken ? { url, authToken } : { url });
}
