// Where an authorization code may be sent: the chat apps' own callbacks, so a
// client an attacker registers can't receive an operator's code.
// Claude (claude.ai web, Desktop, mobile, Cowork):
//   claude.com/docs/connectors/building/authentication
// ChatGPT, stable and per-connection forms:
//   developers.openai.com/apps-sdk/build/auth
// `{callback_id}` matches one path segment.
export const CHAT_APP_REDIRECT_URIS = [
	"https://claude.ai/api/mcp/auth_callback",
	"https://chatgpt.com/connector_platform_oauth_redirect",
	"https://chatgpt.com/connector/oauth/{callback_id}",
] as const;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PATTERNS = CHAT_APP_REDIRECT_URIS.map(
	(uri) =>
		new RegExp(
			`^${uri.split("{callback_id}").map(escapeRegExp).join("[A-Za-z0-9_-]+")}$`,
		),
);

// Plus http loopback on any port and path, for desktop and CLI clients
// (RFC 8252 §7.3); the code never leaves the operator's machine.
export function isAllowedRedirectUri(uri: string): boolean {
	if (PATTERNS.some((pattern) => pattern.test(uri))) return true;
	if (!URL.canParse(uri)) return false;
	const url = new URL(uri);
	return (
		url.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1")
	);
}
