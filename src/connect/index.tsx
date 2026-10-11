import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
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
import { parseOrigin, parseTypedOrigin } from "../deployment/origin";
import { type ConnectOutcome, type ConnectStep, log } from "../log";
import type { Secret } from "../secret";
import { AddressPage, MessagePage } from "./page";

// Where a request ends without the form: the page's heading and its one line.
const END = {
	timedOut: {
		heading: "Connection request timed out",
		message:
			"This connection request timed out. Go back to Claude or ChatGPT and press Connect again.",
	},
	denied: {
		heading: "Connection not allowed",
		message:
			"You didn't allow the connection. Go back to Claude or ChatGPT and press Connect to try again.",
	},
	didntFinish: {
		heading: "Couldn't finish connecting",
		message:
			"Connecting didn't finish. Go back to Claude or ChatGPT and press Connect again.",
	},
	crossSite: {
		heading: "Couldn't connect",
		message:
			"This form has to be sent from this page. Go back to Claude or ChatGPT and press Connect again.",
	},
} as const;
type End = (typeof END)[keyof typeof END];

// What the address form says under the field.
const FIELD = {
	notAnAddress:
		"Enter your donation page's web address, like give.yourcharity.org.",
	needsUpdate:
		"We couldn't find Better Giving at that address. Use your donation page or dashboard address, not your organization's main website. If the address is right, Better Giving there needs updating to the latest release.",
	unreachable: "That address didn't answer. Check it and try again.",
} as const;

export type ConnectDeps = {
	auth: Pick<
		AuthFacade,
		"readLoginRequest" | "completeConnection" | "denyConnection"
	>;
	client: Pick<DeploymentClient, "hello" | "allowUrl" | "exchange">;
	stateSecret: string;
	/** This service's origin, the only one the address form posts from. */
	publicUrl: string;
};

const STATE_COOKIE = "connect";
// Bounds the cookie only: the return verifies the login request it carries again.
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

// `login`: the chat app's signed request, once it has verified on this request.
type ConnectEnv = { Variables: { login?: string } };

// Cancel and "Back to the chat" post here; the login request rides in the query.
const cancelAction = (oauthQuery: string) => `/connect/cancel?${oauthQuery}`;

// A page with one thing left for the operator to do, and a way back to the
// chat while the login request still verifies.
function endPage(
	c: Context<ConnectEnv>,
	end: End,
	status: 400 | 403 | 500 | 502,
) {
	const login = c.get("login");
	return c.html(
		<MessagePage
			heading={end.heading}
			message={end.message}
			back={login === undefined ? undefined : cancelAction(login)}
		/>,
		status,
	);
}

function stop(
	c: Context<ConnectEnv>,
	step: ConnectStep,
	outcome: ConnectOutcome,
	end: End,
	status: 400 | 502,
) {
	log({ kind: "connect", step, outcome });
	return endPage(c, end, status);
}

export function connectRoutes(deps: ConnectDeps): Hono<ConnectEnv> {
	const app = new Hono<ConnectEnv>();
	const sameOrigin = csrf({ origin: deps.publicUrl });

	// One header, not secureHeaders(): its Cross-Origin-Opener-Policy default
	// would cut the chat app's sign-in window off from the window that opened it.
	app.use(async (c, next) => {
		c.header("Content-Security-Policy", "frame-ancestors 'none'");
		await next();
	});

	app.get("/", async (c) => {
		const url = new URL(c.req.url);
		const login = await deps.auth.readLoginRequest(url);
		if (!login) return stop(c, "open", "expired", END.timedOut, 400);
		return c.html(
			<AddressPage
				action={url.pathname + url.search}
				cancel={cancelAction(login.oauthQuery)}
			/>,
		);
	});

	app.post("/", sameOrigin, formOnly, addressForm, async (c) => {
		const url = new URL(c.req.url);
		const login = await deps.auth.readLoginRequest(url);
		if (!login) return stop(c, "address", "expired", END.timedOut, 400);
		c.set("login", login.oauthQuery);
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
					cancel={cancelAction(login.oauthQuery)}
					value={address}
					error={error}
				/>,
				status,
			);
		};
		const typed = parseTypedOrigin(address);
		if (!typed) return askAgain("invalid_address", FIELD.notAnAddress, 400);
		let hello: Hello;
		try {
			hello = await deps.client.hello(typed);
		} catch (error) {
			if (error instanceof NeedsUpdate) {
				return askAgain("needs_update", FIELD.needsUpdate, 400);
			}
			if (error instanceof Unreachable) {
				return askAgain("unreachable", FIELD.unreachable, 502);
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
	});

	app.get("/return", async (c) => {
		const state = readHandshake(
			await getSignedCookie(
				c,
				deps.stateSecret,
				STATE_COOKIE,
				COOKIE_SCOPE.prefix,
			),
		);
		if (!state) return stop(c, "return", "expired", END.timedOut, 400);
		const { state: returned, error, code } = c.req.query();
		// A return for another tab's request leaves this browser's live one alone.
		if (state.nonce !== returned) {
			return stop(c, "return", "state_mismatch", END.timedOut, 400);
		}
		deleteCookie(c, STATE_COOKIE, COOKIE_SCOPE);
		// Checked ahead of the exchange: the deployment mints the key only when
		// /exchange redeems the code (`/connector/v1` contract → Handshake), so a
		// timed-out request leaves no key anywhere. One expiring past here is
		// LoginRequestRefused.
		const login = new URL(`?${state.oauthQuery}`, c.req.url);
		if (!(await deps.auth.readLoginRequest(login))) {
			return stop(c, "return", "expired", END.timedOut, 400);
		}
		c.set("login", state.oauthQuery);
		if (error === "access_denied") {
			return stop(c, "return", "denied", END.denied, 400);
		}
		if (error !== undefined || !code) {
			return stop(c, "return", "failed", END.didntFinish, 400);
		}

		let key: Secret;
		try {
			key = await deps.client.exchange(state.origin, code);
		} catch (error) {
			const failed = exchangeFailure(error);
			if (!failed) throw error;
			return stop(
				c,
				"exchange",
				failed.outcome,
				END.didntFinish,
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
			c.set("login", undefined);
			return stop(c, "complete", "expired", END.didntFinish, 400);
		}
		const location = done.headers.get("location");
		if (!location) throw new Error("completeConnection answered no redirect");
		const sentCode = new URL(location, c.req.url).searchParams.has("code");
		log({
			kind: "connect",
			step: "complete",
			outcome: sentCode ? "ok" : "failed",
		});
		return c.redirect(location, 302);
	});

	app.post("/cancel", sameOrigin, async (c) => {
		let denied: Response;
		try {
			denied = await deps.auth.denyConnection(
				new URL(c.req.url).search.slice(1),
			);
		} catch (error) {
			if (!(error instanceof LoginRequestRefused)) throw error;
			return stop(c, "cancel", "expired", END.timedOut, 400);
		}
		const location = denied.headers.get("location");
		if (!location) throw new Error("denyConnection answered no redirect");
		log({ kind: "connect", step: "cancel", outcome: "ok" });
		return c.redirect(location, 302);
	});

	// Every failure here lands on a page; the app's JSON 500 never reaches the operator.
	app.onError((err, c) => {
		if (err instanceof HTTPException) {
			// csrf refuses with a 403; the form validator's 400 is for a body no
			// browser sends from this page.
			if (err.status === 403) return endPage(c, END.crossSite, 403);
			return err.getResponse();
		}
		log({ kind: "error", where: "connect", errorName: err.name });
		return endPage(c, END.didntFinish, 500);
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
