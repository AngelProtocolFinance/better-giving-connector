/**
 * The OAuth callbacks the chat apps document. Registration (DCR) is open to
 * anyone, and there is no consent screen on this service, so a client may only
 * send codes back to one of these.
 */
const EXACT_CALLBACKS = new Set([
  // Claude (claude.ai, Desktop, mobile, Cowork): claude.com/docs/connectors/building/authentication
  "https://claude.ai/api/mcp/auth_callback",
  // the move Anthropic announces in support.claude.com/en/articles/11503834
  "https://claude.com/api/mcp/auth_callback",
  // ChatGPT, for an issuer that returns RFC 9207 `iss`: developers.openai.com/apps-sdk/build/auth
  "https://chatgpt.com/connector_platform_oauth_redirect",
]);

/** ChatGPT's per-connection form of the same callback, `/connector/oauth/{callback_id}`. */
const CHATGPT_CALLBACK_ID =
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/;

/** RFC 8252 loopback, any port: Claude Code and other local MCP clients. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Whether a client may register `uri` as a redirect URI. */
export function isAllowedRedirectUri(uri: string): boolean {
  if (EXACT_CALLBACKS.has(uri) || CHATGPT_CALLBACK_ID.test(uri)) return true;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.username === "" &&
    url.password === ""
  );
}
