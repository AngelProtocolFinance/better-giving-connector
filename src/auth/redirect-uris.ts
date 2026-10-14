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

export const isAllowedRedirectUri = (uri: string): boolean =>
	PATTERNS.some((pattern) => pattern.test(uri));
