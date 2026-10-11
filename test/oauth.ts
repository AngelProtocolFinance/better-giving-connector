import { createHash, randomBytes } from "node:crypto";

// A chat app's side of the OAuth dance, driven against any in-process
// `fetch` (auth.handler, or the whole app's `app.request`). It finds every
// endpoint the way Claude and ChatGPT do: protected-resource metadata →
// authorization-server metadata.

export type Call = (req: Request) => Promise<Response>;

export type Endpoints = {
	resource: string;
	authorization: string;
	token: string;
	registration: string;
};

export type Tokens = {
	access_token: string;
	refresh_token: string;
	token_type: string;
	expires_in: number;
	scope: string;
};

// Claude's hosted callback: the connector accepts only the chat apps' own
export const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

export async function discover(call: Call, base: string): Promise<Endpoints> {
	const prm = await getJson(
		call,
		`${base}/.well-known/oauth-protected-resource`,
	);
	const issuer = new URL(String(prm.authorization_servers[0]));
	const as = await getJson(
		call,
		`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`,
	);
	return {
		resource: prm.resource,
		authorization: as.authorization_endpoint,
		token: as.token_endpoint,
		registration: as.registration_endpoint,
	};
}

export async function registerClient(
	call: Call,
	ep: Endpoints,
	redirectUri = REDIRECT_URI,
): Promise<Registration> {
	const res = await call(
		new Request(ep.registration, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Chat app",
				redirect_uris: [redirectUri],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
			}),
		}),
	);
	if (res.status !== 201 && res.status !== 200) {
		throw new Error(`registration failed: ${res.status} ${await res.text()}`);
	}
	return res.json() as Promise<Registration>;
}

export type Registration = {
	client_id: string;
	client_secret?: string;
	token_endpoint_auth_method: string;
};

export type Authorization = {
	clientId: string;
	verifier: string;
	state: string;
	// the RFC 8707 resource sent at authorize and token; MCP clients send it
	resource: string | null;
	url: string;
};

// The authorize URL a chat app opens in the operator's browser.
export function authorization(
	ep: Endpoints,
	clientId: string,
	// null leaves `resource` out, as a client ignoring RFC 8707 would
	{ resource = ep.resource as string | null } = {},
): Authorization {
	const verifier = randomBytes(32).toString("base64url");
	const state = randomBytes(16).toString("base64url");
	const url = new URL(ep.authorization);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
		state,
		...(resource ? { resource } : {}),
	}).toString();
	return { clientId, verifier, state, resource, url: url.toString() };
}

// Opens the authorize URL as a browser navigation with no cookies and returns
// where it sends the browser.
export async function openAuthorization(
	call: Call,
	a: Authorization,
): Promise<URL> {
	const res = await call(
		new Request(a.url, {
			headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
		}),
	);
	return redirectTarget(res, a.url);
}

export function redirectTarget(res: Response, from: string): URL {
	const location = res.headers.get("location");
	if (res.status !== 302 || !location) {
		throw new Error(`expected a 302, got ${res.status}`);
	}
	return new URL(location, from);
}

export async function exchangeCode(
	call: Call,
	ep: Endpoints,
	a: Authorization,
	code: string,
): Promise<Response> {
	return tokenRequest(call, ep, {
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT_URI,
		client_id: a.clientId,
		code_verifier: a.verifier,
		...(a.resource ? { resource: a.resource } : {}),
	});
}

export async function refresh(
	call: Call,
	ep: Endpoints,
	clientId: string,
	refreshToken: string,
): Promise<Response> {
	return tokenRequest(call, ep, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId,
		resource: ep.resource,
	});
}

function tokenRequest(
	call: Call,
	ep: Endpoints,
	form: Record<string, string>,
): Promise<Response> {
	return call(
		new Request(ep.token, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(form),
		}),
	);
}

// biome-ignore lint/suspicious/noExplicitAny: metadata documents, read field by field
type Metadata = Record<string, any>;

async function getJson(call: Call, url: string): Promise<Metadata> {
	const res = await call(new Request(url));
	if (res.status !== 200) throw new Error(`GET ${url}: ${res.status}`);
	return res.json() as Promise<Metadata>;
}
