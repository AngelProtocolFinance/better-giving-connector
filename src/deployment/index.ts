import { Secret } from "../secret";
import {
	ACTIONS,
	type ActionName,
	ALLOW_PATH,
	BASE_PATH,
	exchangeBody,
	helloBody,
	problemCode,
} from "./contract";
import {
	CodeInvalid,
	DeploymentRejected,
	KeyRefused,
	NeedsUpdate,
	Unreachable,
} from "./errors";
import { type Origin, parseOrigin } from "./origin";

export { type ActionName, isActionName } from "./contract";
export {
	CodeInvalid,
	DeploymentRejected,
	KeyRefused,
	NeedsUpdate,
	Unreachable,
} from "./errors";

export type Hello = {
	/** Where hello answered: the typed origin, or the one it moved to. */
	origin: Origin;
	release: string;
	orgName: string;
	actions: ActionName[];
};

export type DeploymentClient = {
	/**
	 * Unauthenticated probe: is there a Better Giving speaking this contract at
	 * `origin`? Follows one redirect to another origin `parseOrigin` accepts, so
	 * an apex typed for a www site (or the reverse) still connects.
	 */
	hello(origin: Origin): Promise<Hello>;
	/** The deployment's Allow screen; it returns the browser to an address fixed in its own code. */
	allowUrl(origin: Origin, state: string): URL;
	exchange(origin: Origin, code: string): Promise<Secret>;
	/**
	 * Runs one contract action with the connection's key. Path params (`:id`)
	 * are taken from `input`; the rest goes as query on GET, JSON body otherwise.
	 */
	call(
		conn: DeploymentTarget,
		action: ActionName,
		input: Record<string, unknown>,
	): Promise<unknown>;
};

export type DeploymentTarget = { origin: Origin; key: Secret };

const TIMEOUT_MS = 15_000;
// hello runs before sign-in against any address typed, so an unbounded read
// would let anyone stream the function out of memory.
const MAX_BODY_BYTES = 1024 * 1024;
const NOT_JSON = Symbol("not json");

type Answer = { status: number; body: unknown; location: string | null };

export function deploymentClient(deps: {
	fetch: typeof fetch;
}): DeploymentClient {
	// Any throw from fetch or the body read — refused redirect, DNS, reset, the
	// timeout's abort, a body over the cap — is Unreachable; the original error
	// is dropped, not chained, because its message can carry the URL and so a
	// tool input.
	async function send(
		url: string,
		init: RequestInit = {},
		redirect: "error" | "manual" = "error",
	): Promise<Answer> {
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
		try {
			const res = await deps.fetch(url, {
				...init,
				redirect,
				signal: abort.signal,
			});
			return {
				status: res.status,
				body: parseJson(await readBody(res)),
				location: res.headers.get("location"),
			};
		} catch {
			abort.abort();
			throw new Unreachable();
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		async hello(typed) {
			const helloUrl = (at: Origin) => `${at}${BASE_PATH}/hello`;
			let origin = typed;
			let answer = await send(helloUrl(origin), {}, "manual");
			if (isRedirect(answer.status)) {
				const target = answer.location
					? parseOrigin(new URL(answer.location, helloUrl(origin)).href)
					: null;
				if (!target || target === origin) throw new Unreachable();
				origin = target;
				// A second hop fails the fetch, so it is Unreachable.
				answer = await send(helloUrl(origin));
			}
			const { status, body } = answer;
			// Only a 404 or a body that isn't ours means "not this contract"; a 401, 403
			// or 429 is a wall in front of the site (protection, a challenge, a rate limit).
			if (status !== 404 && !isSuccess(status)) throw new Unreachable();
			const hello = helloBody.safeParse(body);
			if (status === 404 || !hello.success) throw new NeedsUpdate();
			return { origin, ...hello.data };
		},

		allowUrl(origin, state) {
			const url = new URL(ALLOW_PATH, origin);
			url.searchParams.set("state", state);
			return url;
		},

		async exchange(origin, code) {
			const answer = await send(`${origin}${BASE_PATH}/exchange`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
				},
				body: JSON.stringify({ code }),
			});
			if (answer.status === 400 && codeOf(answer.body) === "code_invalid") {
				throw new CodeInvalid();
			}
			// exchange sends no key, so a 401 is a wall in front of the site, not a refused key.
			if (answer.status === 401) throw new Unreachable();
			const parsed = exchangeBody.safeParse(succeeded(answer));
			if (!parsed.success) throw new Unreachable();
			return new Secret(parsed.data.key);
		},

		async call(conn, action, input) {
			const { method, path } = ACTIONS[action];
			const rest = { ...input };
			// Encoded, so an id can't add a path segment, let alone change the host.
			const filled = path.replace(/:(\w+)/g, (_, name: string) => {
				const value = rest[name];
				delete rest[name];
				return encodeURIComponent(String(value));
			});
			const url = new URL(`${conn.origin}${BASE_PATH}${filled}`);
			const headers: Record<string, string> = {
				authorization: `Bearer ${conn.key.reveal()}`,
				accept: "application/json",
			};
			let body: string | undefined;
			if (method === "GET") {
				for (const [name, value] of Object.entries(rest)) {
					if (value !== undefined && value !== null)
						url.searchParams.set(name, String(value));
				}
			} else {
				headers["content-type"] = "application/json";
				body = JSON.stringify(rest);
			}
			return succeeded(await send(url.href, { method, headers, body }));
		},
	};
}

// The one status → error mapping for authenticated and exchange requests.
function succeeded({ status, body }: Answer): unknown {
	if (isSuccess(status) && body !== NOT_JSON) return body;
	if (status === 401) throw new KeyRefused();
	if (status === 404) {
		// Only `not_found` is a missing resource; any other 404 is a release
		// without this action, or without /connector/v1 at all.
		if (codeOf(body) === "not_found") throw new DeploymentRejected(404, body);
		throw new NeedsUpdate();
	}
	if (status >= 400 && status < 500) {
		throw new DeploymentRejected(status, body === NOT_JSON ? null : body);
	}
	throw new Unreachable();
}

const isSuccess = (status: number) => status >= 200 && status < 300;
const isRedirect = (status: number) => status >= 300 && status < 400;

const codeOf = (body: unknown) => problemCode.safeParse(body).data?.code;

async function readBody(res: Response): Promise<string> {
	if (Number(res.headers.get("content-length")) > MAX_BODY_BYTES) {
		throw new RangeError("response over the size cap");
	}
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return new TextDecoder().decode(Buffer.concat(chunks));
		size += value.byteLength;
		if (size > MAX_BODY_BYTES) {
			await reader.cancel();
			throw new RangeError("response over the size cap");
		}
		chunks.push(value);
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return NOT_JSON;
	}
}
