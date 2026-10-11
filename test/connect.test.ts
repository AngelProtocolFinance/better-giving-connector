import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app";
import { connections, createDb, type Db } from "../src/db";
import { migrate } from "../src/db/migrate";
import {
	type FakeDeployment,
	fakeDeployment,
	fakeNetwork,
} from "./fake-deployment";
import { BASE, env, INITIALIZE, mcpPost, rpc, warmUp } from "./harness";
import {
	type Call,
	exchangeCode,
	REDIRECT_URI,
	redirectTarget,
	type Tokens,
} from "./oauth";
import { type ConnectFlow, connectFlow, cookieFrom, shown } from "./operator";

let db: Db;
let deployment: FakeDeployment;
let call: Call;
let flow: ConnectFlow;

function serve(fetch: typeof globalThis.fetch) {
	const app = createApp({ env, db, fetch });
	call = async (req) => app.request(req);
	flow = connectFlow(call, deployment, BASE);
}

beforeEach(async () => {
	db = createDb({ url: ":memory:" });
	await migrate(db);
	deployment = fakeDeployment({ name: "Hope Shelter" });
	serve(deployment.fetch);
	await warmUp(call);
	return () => db.close();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const loginUrl = async () => (await flow.startSignIn()).login;

const later = (minutes: number) => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + minutes * 60_000);
};

// The key the one connection holds, decrypted.
async function storedKey(): Promise<string | undefined> {
	const { rows } = await db.execute("SELECT user_id FROM connection");
	const conn = await connections(db, env.CONNECTION_KEY_SECRET).get(
		String(rows[0]?.user_id),
	);
	return conn?.key.reveal();
}

// Every connection row, as origin and org name.
async function connectionRows() {
	const { rows } = await db.execute("SELECT origin, org_name FROM connection");
	return rows.map((r) => ({ origin: r.origin, orgName: r.org_name }));
}

const requestsTo = (path: string) =>
	deployment.calls.filter((c) => c.path === `/connector/v1/${path}`);

const answer = (path: string, status: number) =>
	deployment.intercept((req) =>
		new URL(req.url).pathname === `/connector/v1/${path}`
			? new Response(null, { status })
			: undefined,
	);

async function instructions(tokens: Tokens): Promise<string> {
	const res = await call(mcpPost(INITIALIZE, `Bearer ${tokens.access_token}`));
	return (await rpc(res)).result.instructions;
}

const TIMED_OUT = {
	heading: "Connection request timed out",
	message:
		"This connection request timed out. Go back to Claude or ChatGPT and press Connect again.",
};
const DENIED = {
	heading: "Connection not allowed",
	message:
		"You didn't allow the connection. Go back to Claude or ChatGPT and press Connect to try again.",
};
const DIDNT_FINISH = {
	heading: "Couldn't finish connecting",
	message:
		"Connecting didn't finish. Go back to Claude or ChatGPT and press Connect again.",
};
const NOT_AN_ADDRESS = "Enter your donation page's web address.";
const NEEDS_UPDATE =
	"We couldn't find Better Giving at that address. Use your donation page or dashboard address, not your organization's main website. If the address is right, Better Giving there needs updating to the latest release.";
const UNREACHABLE = "That address didn't answer. Check it and try again.";

// The page a flow ended on: its status, and the outcome it is titled and headed for.
async function expectPage(
	res: Response,
	status: number,
	page: { heading: string; message: string },
): Promise<string> {
	expect(res.status).toBe(status);
	const html = shown(await res.text());
	expect(html).toContain(`<title>${page.heading}</title>`);
	expect(html).toContain(`<h1>${page.heading}</h1>`);
	expect(html).toContain(page.message);
	return html;
}

test("connecting walks from the address page through Allow to a working /mcp", async () => {
	const chat = await flow.startSignIn();
	const handOff = await flow.submitAddress("give.example.org", chat.login);
	const back = await flow.press(handOff.headers.get("location") ?? "");

	const done = await flow.returnTo(back, cookieFrom(handOff));

	const callback = redirectTarget(done, back.href);
	expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
	expect(callback.searchParams.get("state")).toBe(chat.a.state);
	const token = await exchangeCode(
		call,
		chat.ep,
		chat.a,
		callback.searchParams.get("code") ?? "",
	);
	expect(token.status).toBe(200);
	expect(await instructions((await token.json()) as Tokens)).toContain(
		"Hope Shelter",
	);
});

test("the address page is a form asking for the Better Giving site's address", async () => {
	const res = await call(new Request(await loginUrl()));

	expect(res.headers.get("content-type")).toMatch(/^text\/html/);
	const html = await expectPage(res, 200, {
		heading: "Connect Better Giving",
		message:
			"Type your Better Giving site's address. You'll sign in to your dashboard there and press Allow.",
	});
	expect(html).toMatch(/^<!doctype html>/i);
	expect(html).toContain(
		'<label for="address">Your Better Giving site address</label>',
	);
	const input = html.match(/<input[^>]*name="address"[^>]*>/)?.[0] ?? "";
	const hint = input.match(/aria-describedby="([^"]+)"/)?.[1];
	expect(html).toContain(
		`<p id="${hint}" class="hint">The address of your donation page or Better Giving dashboard, like give.yourcharity.org.</p>`,
	);
	expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Continue<\/button>/);
});

test("the page's stylesheet reaches the browser unescaped", async () => {
	const html = await (await call(new Request(await loginUrl()))).text();

	const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
	expect(style).toContain('"Segoe UI"');
	expect(style).not.toContain("&quot;");
});

test.each([
	["no login request", async () => `${BASE}/connect`],
	[
		"a tampered login request",
		async () => (await loginUrl()).href.replace("client_id=", "client_id=x"),
	],
])("the address page with %s says the request timed out", async (_, url) => {
	const res = await call(new Request(await url()));

	const html = await expectPage(res, 400, TIMED_OUT);
	expect(html).not.toContain("<form");
});

test("an address hands the browser to the deployment's Allow with a state cookie", async () => {
	const res = await flow.submitAddress("give.example.org");

	expect(res.status).toBe(302);
	const allow = new URL(res.headers.get("location") ?? "");
	expect(allow.origin).toBe(deployment.origin);
	expect(allow.pathname).toBe("/admin/connector/allow");
	expect(allow.searchParams.get("state")).toMatch(/^[\w-]{32,}$/);
	const cookie = res.headers.get("set-cookie") ?? "";
	expect(cookie).toMatch(/^__Secure-connect=/);
	expect(cookie).toMatch(/; Max-Age=600(;|$)/);
	expect(cookie).toMatch(/; Path=\/connect(;|$)/);
	expect(cookie).toMatch(/; HttpOnly(;|$)/);
	expect(cookie).toMatch(/; Secure(;|$)/);
	expect(cookie).toMatch(/; SameSite=Lax(;|$)/);
});

test.each([
	"give.example.org",
	" Give.Example.org ",
	"https://give.example.org/donate?campaign=winter",
	"http://give.example.org",
])("typing %j connects to that deployment", async (address) => {
	await flow.connect(address);

	expect(await connectionRows()).toEqual([
		{ origin: "https://give.example.org", orgName: "Hope Shelter" },
	]);
});

test("an apex that redirects to www connects to www", async () => {
	const apex = fakeDeployment({ host: "hopeshelter.org" });
	apex.intercept(
		() =>
			new Response(null, {
				status: 301,
				headers: { location: "https://www.hopeshelter.org/connector/v1/hello" },
			}),
	);
	deployment = fakeDeployment({
		host: "www.hopeshelter.org",
		name: "Hope Shelter",
	});
	serve(fakeNetwork(apex, deployment));

	const at = await flow.toReturn("hopeshelter.org");
	await flow.finish(at);

	expect(new URL(at.allow).origin).toBe("https://www.hopeshelter.org");
	expect(await connectionRows()).toEqual([
		{ origin: "https://www.hopeshelter.org", orgName: "Hope Shelter" },
	]);
});

test("a release serving fewer actions still connects", async () => {
	deployment.setActions(["campaigns.list"]);

	const tokens = await flow.connect();

	expect(await instructions(tokens)).toContain("Hope Shelter");
});

test.each([
	["text that isn't an address", "my charity", 400, NOT_AN_ADDRESS, () => {}],
	["a blank address", "", 400, NOT_AN_ADDRESS, () => {}],
	[
		"an address with no Better Giving",
		"give.example.org",
		400,
		NEEDS_UPDATE,
		() => answer("hello", 404),
	],
	[
		"an address that doesn't answer",
		"nowhere.example.org",
		502,
		UNREACHABLE,
		() => {},
	],
])(
	"%s is asked for again, the typed value kept",
	async (_, address, status, message, arrange) => {
		arrange();

		const res = await flow.submitAddress(address);

		expect(res.status).toBe(status);
		expect(res.headers.get("set-cookie")).toBeNull();
		const html = shown(await res.text());
		const input = html.match(/<input[^>]*>/)?.[0] ?? "";
		expect(input).toContain(`value="${address}"`);
		expect(input).toContain('aria-invalid="true"');
		const described = (input.match(/aria-describedby="([^"]+)"/)?.[1] ?? "")
			.split(" ")
			.map(
				(id) => html.match(new RegExp(`<p id="${id}"[^>]*>([^<]*)</p>`))?.[1],
			);
		expect(described).toContain(message);
	},
);

// A POST to the address page's own URL, built by hand.
async function postAddress(init: RequestInit, login?: URL): Promise<Response> {
	return call(
		new Request(login ?? (await loginUrl()), { method: "POST", ...init }),
	);
}

test("a cross-site post of the address form is refused before any hello", async () => {
	const res = await postAddress({
		headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
		body: new URLSearchParams({ address: "give.example.org" }),
	});

	const html = await expectPage(res, 403, {
		heading: "Couldn't connect",
		message:
			"This form has to be sent from this page. Go back to Claude or ChatGPT and press Connect again.",
	});
	expect(html).not.toContain("<form");
	expect(requestsTo("hello")).toEqual([]);
});

test("an address sent as anything but a form is refused before any hello", async () => {
	const res = await postAddress({
		headers: {
			origin: BASE,
			"sec-fetch-site": "same-origin",
			"content-type": "application/json",
		},
		body: JSON.stringify({ address: "give.example.org" }),
	});

	expect(res.status).toBe(415);
	expect(requestsTo("hello")).toEqual([]);
});

test("an address posted after the request expired says it timed out before any hello", async () => {
	const login = await loginUrl();
	later(11);

	const res = await postAddress(
		{
			headers: { origin: BASE, "sec-fetch-site": "same-origin" },
			body: new URLSearchParams({ address: "give.example.org" }),
		},
		login,
	);

	await expectPage(res, 400, TIMED_OUT);
	expect(requestsTo("hello")).toEqual([]);
});

test("the return clears the state cookie", async () => {
	const { back, cookie } = await flow.toReturn();

	const done = await flow.returnTo(back, cookie);

	expect(done.status).toBe(302);
	expect(done.headers.getSetCookie()).toEqual([
		expect.stringMatching(
			/^__Secure-connect=; Max-Age=0; Path=\/connect; Secure$/,
		),
	]);
});

test.each([
	["another browser's cookie", async () => (await flow.toReturn()).cookie],
	["no cookie", async () => ""],
	[
		"a forged cookie",
		async (mine: string) => mine.replace(/\.[^.]+$/, ".Zm9yZ2Vk"),
	],
])(
	"a return with %s says the request timed out and exchanges nothing",
	async (_, cookieFor) => {
		const { back, cookie } = await flow.toReturn();
		const used = await cookieFor(cookie);

		const res = await flow.returnTo(back, used);

		await expectPage(res, 400, TIMED_OUT);
		expect(requestsTo("exchange")).toEqual([]);
	},
);

test("a return after the chat app's request expired says it timed out and exchanges nothing", async () => {
	const { back, cookie } = await flow.toReturn();
	later(11);

	const res = await flow.returnTo(back, cookie);

	const html = await expectPage(res, 400, TIMED_OUT);
	expect(html).not.toContain("<form");
	expect(requestsTo("exchange")).toEqual([]);
});

test("pressing Deny says the connection wasn't allowed and exchanges nothing", async () => {
	const { allow, cookie } = await flow.toReturn();
	const back = await flow.press(allow, "deny");

	const res = await flow.returnTo(back, cookie);

	await expectPage(res, 400, DENIED);
	expect(requestsTo("exchange")).toEqual([]);
});

test("a replayed return says connecting didn't finish and makes no second connection", async () => {
	const { back, cookie } = await flow.toReturn();
	expect((await flow.returnTo(back, cookie)).status).toBe(302);

	const replay = await flow.returnTo(back, cookie);

	await expectPage(replay, 400, DIDNT_FINISH);
	expect(await connectionRows()).toEqual([
		{ origin: deployment.origin, orgName: "Hope Shelter" },
	]);
});

test.each([
	["the exchange gets no answer", 503],
	["the deployment refuses the exchange", 403],
])(
	"when %s, connecting didn't finish and nothing is kept",
	async (_, status) => {
		const { back, cookie } = await flow.toReturn();
		answer("exchange", status);

		const res = await flow.returnTo(back, cookie);

		await expectPage(res, 502, DIDNT_FINISH);
		expect(await connectionRows()).toEqual([]);
	},
);

test("the deployment's key reaches no response and no log line", async () => {
	const lines = [
		vi.spyOn(console, "log").mockImplementation(() => {}),
		vi.spyOn(console, "error").mockImplementation(() => {}),
	];
	const seen: string[] = [];
	const watched: Call = async (req) => {
		const res = await call(req);
		const headers = [...res.headers].map(
			([name, value]) => `${name}: ${value}`,
		);
		seen.push(...headers, await res.clone().text());
		return res;
	};
	flow = connectFlow(watched, deployment, BASE);

	const at = await flow.toReturn();
	const tokens = await flow.finish(at);
	await watched(mcpPost(INITIALIZE, `Bearer ${tokens.access_token}`));
	await flow.returnTo(at.back, at.cookie);

	const [key] = deployment.issuedKeys;
	expect(await storedKey()).toBe(key);
	const written = lines.flatMap((spy) => spy.mock.calls.flat().map(String));
	expect(written).not.toEqual([]);
	for (const text of [...seen, ...written]) expect(text).not.toContain(key);
	expect(shown(seen.join("\n"))).toContain(DIDNT_FINISH.message);
});

test.each([
	["a connection", "allow", ["address:ok", "complete:ok"]],
	["a denial", "deny", ["address:ok", "return:denied"]],
] as const)(
	"%s writes one line per step it ended",
	async (_, button, expected) => {
		const lines = vi.spyOn(console, "log").mockImplementation(() => {});
		const { allow, cookie } = await flow.toReturn();

		await flow.returnTo(await flow.press(allow, button), cookie);

		const connect = lines.mock.calls
			.map(([line]) => JSON.parse(String(line)))
			.filter((e) => e.kind === "connect")
			.map((e) => `${e.step}:${e.outcome}`);
		expect(connect).toEqual(expected);
	},
);

test("a stale tab's return leaves the newer request's cookie alone", async () => {
	const stale = await flow.toReturn();
	const fresh = await flow.toReturn();

	const res = await flow.returnTo(stale.back, fresh.cookie);

	await expectPage(res, 400, TIMED_OUT);
	expect(res.headers.getSetCookie()).toEqual([]);
	expect((await flow.returnTo(fresh.back, fresh.cookie)).status).toBe(302);
});

test.each([
	[
		"another error",
		(back: URL) => back.searchParams.set("error", "server_error"),
	],
	["no code", (back: URL) => back.searchParams.delete("code")],
])(
	"a return with %s says connecting didn't finish and exchanges nothing",
	async (_, change) => {
		const { back, cookie } = await flow.toReturn();
		change(back);

		const res = await flow.returnTo(back, cookie);

		await expectPage(res, 400, DIDNT_FINISH);
		expect(requestsTo("exchange")).toEqual([]);
	},
);

test("an unexpected failure shows the didn't-finish page and logs only the error's name", async () => {
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	deployment.intercept(
		() =>
			new Response(null, { status: 301, headers: { location: "https://[" } }),
	);

	const res = await flow.submitAddress("give.example.org");

	await expectPage(res, 500, DIDNT_FINISH);
	expect(errors.mock.calls).toEqual([
		[
			JSON.stringify({
				kind: "error",
				where: "connect",
				errorName: "TypeError",
			}),
		],
	]);
});

test.each([
	["the address page", async () => call(new Request(await loginUrl()))],
	["a timed-out page", async () => call(new Request(`${BASE}/connect`))],
	[
		"the cross-site refusal",
		async () =>
			postAddress({
				headers: {
					origin: "https://evil.example",
					"sec-fetch-site": "cross-site",
				},
				body: new URLSearchParams({ address: "give.example.org" }),
			}),
	],
])("%s can't be framed", async (_, open) => {
	const res = await open();

	expect(res.headers.get("content-security-policy")).toBe(
		"frame-ancestors 'none'",
	);
});

test("Continue shows it's checking once pressed, and comes back on a return to the page", async () => {
	const html = await (await call(new Request(await loginUrl()))).text();
	const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
	const on: Record<string, () => void> = {};
	const button = { disabled: false, textContent: "Continue" };
	const elements: Record<string, unknown> = {
		"address-form": {
			addEventListener: (type: string, fn: () => void) => {
				on[`form:${type}`] = fn;
			},
		},
		continue: button,
	};
	const document = {
		getElementById: (id: string) =>
			html.includes(`id="${id}"`) ? elements[id] : null,
	};
	const addEventListener = (type: string, fn: () => void) => {
		on[`window:${type}`] = fn;
	};
	new Function("document", "addEventListener", script)(
		document,
		addEventListener,
	);

	on["form:submit"]?.();
	const pending = { ...button };
	on["window:pageshow"]?.();

	expect(pending).toEqual({
		disabled: true,
		textContent: "Checking your address…",
	});
	expect(button).toEqual({ disabled: false, textContent: "Continue" });
});

// Where a way-out button sent the browser, checked as the chat app's denial.
function expectChatToldDenied(res: Response, chat: { a: { state: string } }) {
	const callback = redirectTarget(res, BASE);
	expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
	expect(callback.searchParams.get("error")).toBe("access_denied");
	expect(callback.searchParams.get("state")).toBe(chat.a.state);
}

test("Cancel on the address page tells the chat app the operator declined", async () => {
	const chat = await flow.startSignIn();
	const page = await call(new Request(chat.login));

	const res = await flow.pressButton(page, "Cancel");

	expectChatToldDenied(res, chat);
	expect(await connectionRows()).toEqual([]);
});

test("the address page shown again after a refused address keeps Cancel", async () => {
	const chat = await flow.startSignIn();
	const refused = await flow.submitAddress("my charity", chat.login);

	expectChatToldDenied(await flow.pressButton(refused, "Cancel"), chat);
});

test.each([
	["the denied page", (allow: string) => flow.press(allow, "deny")],
	[
		"the didn't-finish page",
		async (allow: string) => {
			const back = await flow.press(allow);
			answer("exchange", 503);
			return back;
		},
	],
])(
	"Back to the chat on %s tells the chat app the operator declined",
	async (_, arrive) => {
		const { chat, allow, cookie } = await flow.toReturn();
		const page = await flow.returnTo(await arrive(allow), cookie);

		const res = await flow.pressButton(page, "Back to the chat");

		expectChatToldDenied(res, chat);
		expect(await connectionRows()).toEqual([]);
	},
);

test("Cancel after the request expired says it timed out", async () => {
	const page = await call(new Request(await loginUrl()));
	later(11);

	const res = await flow.pressButton(page, "Cancel");

	const html = await expectPage(res, 400, TIMED_OUT);
	expect(html).not.toContain("<form");
});

test("a cross-site Cancel is refused", async () => {
	const login = await loginUrl();

	const res = await call(
		new Request(new URL(`/connect/cancel${login.search}`, BASE), {
			method: "POST",
			headers: {
				origin: "https://evil.example",
				"sec-fetch-site": "cross-site",
			},
			body: new URLSearchParams(),
		}),
	);

	expect(res.status).toBe(403);
});

test("the unexpected-failure page offers Back to the chat", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const chat = await flow.startSignIn();
	deployment.intercept(
		() =>
			new Response(null, { status: 301, headers: { location: "https://[" } }),
	);
	const page = await flow.submitAddress("give.example.org", chat.login);

	expectChatToldDenied(await flow.pressButton(page, "Back to the chat"), chat);
});

test("a malformed form body is a 400, not the cross-site refusal", async () => {
	const res = await postAddress({
		headers: {
			origin: BASE,
			"sec-fetch-site": "same-origin",
			"content-type": "multipart/form-data; boundary=x",
		},
		body: "not multipart",
	});

	expect(res.status).toBe(400);
	expect(requestsTo("hello")).toEqual([]);
});
