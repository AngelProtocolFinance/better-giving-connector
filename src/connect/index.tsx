import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { createMiddleware } from "hono/factory";
import { validator } from "hono/validator";
import { z } from "zod";
import { type AuthFacade, LoginRequestRefused } from "../auth";
import {
	CodeInvalid,
	type DeploymentClient,
	DeploymentRejected,
	type Hello,
	NeedsUpdate,
	Unreachable,
} from "../deployment";
import { parseOrigin } from "../deployment/origin";
import { type ConnectOutcome, type ConnectStep, log } from "../log";
import type { Secret } from "../secret";
import { AddressPage, MessagePage } from "./page";

const SAY = {
	expired:
		"This sign-in has expired. Go back to Claude or ChatGPT and press Connect again.",
	denied:
		"You didn't allow the connection. Go back to Claude or ChatGPT and press Connect to try again.",
	notAnAddress:
		"Enter your donation page's web address, like give.yourcharity.org.",
	needsUpdate:
		"We couldn't find Better Giving at that address. Check it — or, if it is your donation page, update Better Giving to the latest release and try again.",
	unreachable: "That address didn't answer. Check it and try again.",
	didntFinish:
		"Connecting didn't finish. Go back to Claude or ChatGPT and press Connect again.",
} as const;

export type ConnectDeps = {
	auth: Pick<AuthFacade, "readLoginRequest" | "completeConnection">;
	client: Pick<DeploymentClient, "hello" | "allowUrl" | "exchange">;
	/** Signs the state cookie. */
	stateSecret: string;
	/** This service's origin, the only one the address form posts from. */
	publicUrl: string;
};

const STATE_COOKIE = "connect";
// Outlives no login request it carries (their expiry: auth's readLoginRequest).
const STATE_TTL_SECONDS = 600;
const COOKIE_SCOPE = { prefix: "secure", path: "/connect" } as const;

// What the address step hands the return, in the browser's signed cookie only.
const handshake = z.object({
	nonce: z.string(),
	origin: z.string().transform((value, ctx) => {
		const origin = parseOrigin(value);
		if (origin) return origin;
		ctx.addIssue("not an origin");
		return z.NEVER;
	}),
	orgName: z.string(),
	oauthQuery: z.string(),
});
type Handshake = z.output<typeof handshake>;

function readHandshake(raw: string | false | undefined): Handshake | null {
	if (!raw) return null;
	try {
		return handshake.safeParse(JSON.parse(raw)).data ?? null;
	} catch {
		return null;
	}
}

// The form validator reads a body only under a form content type and sees
// `{}` otherwise, which would render as a blank address.
const formOnly = createMiddleware(async (c, next) => {
	const type = c.req.header("content-type") ?? "";
	if (
		!/^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(type)
	) {
		return c.text("Unsupported Media Type", 415);
	}
	await next();
});

const addressForm = validator("form", (form) => ({
	address: typeof form.address === "string" ? form.address : "",
}));

// Ends the request on a page with one thing left for the operator to do.
function stop(
	c: Context,
	step: ConnectStep,
	outcome: ConnectOutcome,
	message: string,
	status: 400 | 502,
) {
	log({ kind: "connect", step, outcome });
	return c.html(<MessagePage message={message} />, status);
}

export function connectRoutes(deps: ConnectDeps): Hono {
	const app = new Hono();

	app.get("/", async (c) => {
		const url = new URL(c.req.url);
		if (!(await deps.auth.readLoginRequest(url))) {
			return stop(c, "open", "expired", SAY.expired, 400);
		}
		return c.html(<AddressPage action={url.pathname + url.search} />);
	});

	app.post(
		"/",
		csrf({ origin: deps.publicUrl }),
		formOnly,
		addressForm,
		async (c) => {
			const url = new URL(c.req.url);
			const login = await deps.auth.readLoginRequest(url);
			if (!login) return stop(c, "address", "expired", SAY.expired, 400);
			const { address } = c.req.valid("form");
			const askAgain = (
				outcome: ConnectOutcome,
				error: string,
				status: 400 | 502,
			) => {
				log({ kind: "connect", step: "address", outcome });
				return c.html(
					<AddressPage
						action={url.pathname + url.search}
						value={address}
						error={error}
					/>,
					status,
				);
			};
			const typed = parseOrigin(address);
			if (!typed) return askAgain("invalid_address", SAY.notAnAddress, 400);
			let hello: Hello;
			try {
				hello = await deps.client.hello(typed);
			} catch (error) {
				if (error instanceof NeedsUpdate) {
					return askAgain("needs_update", SAY.needsUpdate, 400);
				}
				if (error instanceof Unreachable) {
					return askAgain("unreachable", SAY.unreachable, 502);
				}
				throw error;
			}
			const state: Handshake = {
				nonce: randomBytes(32).toString("base64url"),
				origin: hello.origin,
				orgName: hello.orgName,
				oauthQuery: login.oauthQuery,
			};
			await setSignedCookie(
				c,
				STATE_COOKIE,
				JSON.stringify(state),
				deps.stateSecret,
				{
					...COOKIE_SCOPE,
					httpOnly: true,
					sameSite: "Lax",
					maxAge: STATE_TTL_SECONDS,
				},
			);
			log({ kind: "connect", step: "address", outcome: "ok" });
			return c.redirect(
				deps.client.allowUrl(state.origin, state.nonce).href,
				302,
			);
		},
	);

	app.get("/return", async (c) => {
		const state = readHandshake(
			await getSignedCookie(
				c,
				deps.stateSecret,
				STATE_COOKIE,
				COOKIE_SCOPE.prefix,
			),
		);
		deleteCookie(c, STATE_COOKIE, COOKIE_SCOPE);
		if (!state) return stop(c, "return", "expired", SAY.expired, 400);
		if (state.nonce !== c.req.query("state")) {
			return stop(c, "return", "state_mismatch", SAY.expired, 400);
		}
		if (c.req.query("error") === "access_denied") {
			return stop(c, "return", "denied", SAY.denied, 400);
		}
		// Checked ahead of the exchange so an expired sign-in mints no key at
		// the deployment; one expiring past here is LoginRequestRefused.
		const login = new URL(`?${state.oauthQuery}`, c.req.url);
		if (!(await deps.auth.readLoginRequest(login))) {
			return stop(c, "return", "expired", SAY.expired, 400);
		}

		let key: Secret;
		try {
			key = await deps.client.exchange(state.origin, c.req.query("code") ?? "");
		} catch (error) {
			const failed = exchangeFailure(error);
			if (!failed) throw error;
			return stop(
				c,
				"exchange",
				failed.outcome,
				SAY.didntFinish,
				failed.status,
			);
		}

		let done: Response;
		try {
			done = await deps.auth.completeConnection({
				oauthQuery: state.oauthQuery,
				origin: state.origin,
				orgName: state.orgName,
				key,
			});
		} catch (error) {
			if (!(error instanceof LoginRequestRefused)) throw error;
			return stop(c, "complete", "expired", SAY.didntFinish, 400);
		}
		const sentCode = new URL(
			done.headers.get("location") ?? "",
			c.req.url,
		).searchParams.has("code");
		log({
			kind: "connect",
			step: "complete",
			outcome: sentCode ? "ok" : "failed",
		});
		// A returned Response skips the headers set on `c`, the cleared cookie among them.
		const res = new Response(done.body, done);
		for (const cookie of c.res.headers.getSetCookie()) {
			res.headers.append("set-cookie", cookie);
		}
		return res;
	});

	return app;
}

// A used code is the request's fault; anything else the deployment answered
// is its own. Null for an error the exchange doesn't throw.
function exchangeFailure(
	error: unknown,
): { outcome: ConnectOutcome; status: 400 | 502 } | null {
	if (error instanceof CodeInvalid)
		return { outcome: "code_invalid", status: 400 };
	if (error instanceof Unreachable)
		return { outcome: "unreachable", status: 502 };
	if (error instanceof NeedsUpdate || error instanceof DeploymentRejected) {
		return { outcome: "failed", status: 502 };
	}
	return null;
}
