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
import type { Origin } from "./origin";

export type { ActionName } from "./contract";
export {
	CodeInvalid,
	DeploymentRejected,
	KeyRefused,
	NeedsUpdate,
	Unreachable,
} from "./errors";

export type Hello = { release: string; orgName: string; actions: ActionName[] };

export type DeploymentClient = {
	/** Unauthenticated probe: is there a Better Giving speaking this contract at `origin`? */
	hello(origin: Origin): Promise<Hello>;
	/** The deployment's Allow screen; it returns the browser to an address fixed in its own code. */
	allowUrl(origin: Origin, state: string): URL;
	exchange(origin: Origin, code: string): Promise<Secret>;
	/**
	 * Runs one contract action with the connection's key. Path params (`:id`)
	 * are taken from `input`; the rest goes as query on GET, JSON body otherwise.
	 */
	call(
		conn: Connection,
		action: ActionName,
		input: Record<string, unknown>,
	): Promise<unknown>;
};

export type Connection = { origin: Origin; key: Secret };

const TIMEOUT_MS = 15_000;
const NOT_JSON = Symbol("not json");

type Answer = { status: number; body: unknown };

export function deploymentClient(deps: {
	fetch: typeof fetch;
}): DeploymentClient {
	// Any throw from fetch or the body read — refused redirect, DNS, reset, the
	// timeout's abort — is Unreachable; the original error is dropped, not chained,
	// because its message can carry the URL and so a tool input.
	async function send(url: string, init: RequestInit = {}): Promise<Answer> {
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
		try {
			const res = await deps.fetch(url, {
				...init,
				redirect: "error",
				signal: abort.signal,
			});
			return { status: res.status, body: parseJson(await res.text()) };
		} catch {
			throw new Unreachable();
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		async hello(origin) {
			const { status, body } = await send(`${origin}${BASE_PATH}/hello`);
			if (status >= 500) throw new Unreachable();
			const hello = helloBody.safeParse(body);
			if (!isSuccess(status) || !hello.success) throw new NeedsUpdate();
			return hello.data;
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

const codeOf = (body: unknown) => problemCode.safeParse(body).data?.code;

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return NOT_JSON;
	}
}
