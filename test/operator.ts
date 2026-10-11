import type { FakeDeployment } from "./fake-deployment";
import {
	type Authorization,
	authorization,
	type Call,
	discover,
	type Endpoints,
	exchangeCode,
	openAuthorization,
	redirectTarget,
	registerClient,
	type Tokens,
} from "./oauth";

// The operator's side of connecting: the chat app opens its authorize URL,
// the browser lands on /connect, submits an address, presses Allow (or Deny)
// on the deployment and comes back to /connect/return.

export type ChatApp = { ep: Endpoints; a: Authorization; login: URL };

/** Where the browser stands on its way back from the deployment. */
export type AtReturn = {
	chat: ChatApp;
	/** The deployment's Allow screen /connect sent the browser to. */
	allow: string;
	/** The return address Allow sent the browser back to. */
	back: URL;
	/** The browser's cookie header for this service. */
	cookie: string;
};

// HTML text as a browser shows it.
export const shown = (html: string) =>
	html
		.replaceAll("&#39;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");

// The browser's cookie header for what a response set.
export const cookieFrom = (res: Response) =>
	res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");

export type ConnectFlow = ReturnType<typeof connectFlow>;

/** `call` is this service; `deployment` answers the Allow screen. */
export function connectFlow(
	call: Call,
	deployment: FakeDeployment,
	base: string,
) {
	async function startSignIn(): Promise<ChatApp> {
		const ep = await discover(call, base);
		const client = await registerClient(call, ep);
		const a = authorization(ep, client.client_id);
		return { ep, a, login: await openAuthorization(call, a) };
	}

	// Opens the address page and submits `address` through its form, as a
	// browser on this site would.
	async function submitAddress(
		address: string,
		login?: URL,
	): Promise<Response> {
		const page = await call(new Request(login ?? (await startSignIn()).login));
		const form = shown(await page.text()).match(/<form[^>]*action="([^"]*)"/);
		if (!form?.[1]) throw new Error("no form on the address page");
		return call(
			new Request(new URL(form[1], base), {
				method: "POST",
				headers: { origin: base, "sec-fetch-site": "same-origin" },
				body: new URLSearchParams({ address }),
			}),
		);
	}

	// Presses Allow (or Deny) on the deployment; returns where it sends the browser.
	async function press(
		allow: string,
		button: "allow" | "deny" = "allow",
	): Promise<URL> {
		const url = new URL(allow);
		if (button === "deny") url.searchParams.set("press", "deny");
		const res = await deployment.fetch(url, { redirect: "manual" });
		return redirectTarget(res, url.href);
	}

	// Arrives at the return address, which the deployment fixes to the
	// production host, on this service.
	function returnTo(back: URL, cookie: string): Promise<Response> {
		return call(
			new Request(new URL(back.pathname + back.search, base), {
				headers: { cookie },
			}),
		);
	}

	async function toReturn(address = deployment.host): Promise<AtReturn> {
		const chat = await startSignIn();
		const handOff = await submitAddress(address, chat.login);
		const allow = handOff.headers.get("location") ?? "";
		return {
			chat,
			allow,
			back: await press(allow),
			cookie: cookieFrom(handOff),
		};
	}

	// The return, then the chat app trading the code it was sent for tokens.
	async function finish({ chat, back, cookie }: AtReturn): Promise<Tokens> {
		const done = await returnTo(back, cookie);
		const code = redirectTarget(done, back.href).searchParams.get("code");
		const token = await exchangeCode(call, chat.ep, chat.a, code ?? "");
		if (token.status !== 200) throw new Error(`token: ${token.status}`);
		return token.json() as Promise<Tokens>;
	}

	return {
		startSignIn,
		submitAddress,
		press,
		returnTo,
		toReturn,
		finish,
		connect: async (address?: string) => finish(await toReturn(address)),
	};
}
