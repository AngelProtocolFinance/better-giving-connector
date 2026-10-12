import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Origin } from "../src/deployment/origin";

// An in-process Better Giving deployment speaking `/connector/v1` as
// `better-giving-oss` → plan/connector/contract.md describes it. Routes are
// transcribed from that document, not from src/deployment/contract.ts, so the
// two copies check each other.

export const ALL_ACTIONS = [
	"campaigns.list",
	"campaigns.get",
	"campaigns.create",
	"campaigns.update_blocks",
	"campaigns.update_settings",
	"campaigns.publish",
	"campaigns.unpublish",
	"campaigns.end",
	"donation_page.get",
	"donation_page.update_blocks",
	"donation_page.reset",
	"blocks.catalog",
	"forms.list",
	"forms.get",
	"forms.create",
	"forms.update",
	"results.summary",
	"donations.list",
	"donors.list",
	"donors.get",
	"recurring.list",
	"donations.record",
	"photos.upload_link",
] as const;

// Where Allow sends the browser back; fixed in the deployment's code.
export const RETURN_URL = "https://connect.better.giving/connect/return";

export type RecordedCall = {
	method: string;
	host: string;
	path: string;
	query: Record<string, string>;
	authorization: string | null;
	body: unknown;
};

export type Interceptor = (
	req: Request,
) => Response | undefined | Promise<Response | undefined>;

export type FakeDeployment = {
	origin: Origin;
	host: string;
	/** Reaches this host only; any other host fails like a DNS miss. */
	fetch: typeof fetch;
	/** Every request that reached this host, oldest first. */
	calls: RecordedCall[];
	/** Every key `/exchange` has handed out, oldest first, revoked ones included. */
	issuedKeys: string[];
	/** Revokes every key issued so far, as Disconnect does. */
	refuseKeys(): void;
	setRelease(release: string): void;
	setActions(actions: readonly string[]): void;
	/** What pressing Allow mints: a single-use code for `/exchange`. */
	mintCode(): string;
	/** Answers ahead of the deployment while set; `undefined` falls through. */
	intercept(handler: Interceptor | null): void;
	/** The deployment itself, behind the network; `fakeNetwork` calls it. */
	handle(req: Request): Promise<Response>;
};

/** An interceptor that never answers, rejecting only when the request is aborted. */
export const hang: Interceptor = (req) =>
	new Promise((_, reject) => {
		req.signal.addEventListener("abort", () => reject(req.signal.reason));
	});

/**
 * One `fetch` for several fakes, routed by host. Redirects behave as fetch's do:
 * "error" fails, "manual" hands back the 3xx, "follow" follows and drops
 * Authorization on a cross-origin hop.
 */
export function fakeNetwork(...deployments: FakeDeployment[]): typeof fetch {
	const route = (req: Request) => {
		const target = deployments.find((d) => d.host === new URL(req.url).host);
		if (!target) throw new TypeError("fetch failed");
		return target.handle(req);
	};
	return async (input, init) => {
		let req = new Request(input, init);
		const body = req.body ? await req.clone().text() : undefined;
		for (let hop = 0; ; hop++) {
			const res = await route(req);
			const location = res.headers.get("location");
			if (
				res.status < 300 ||
				res.status >= 400 ||
				!location ||
				req.redirect === "manual"
			) {
				return res;
			}
			if (req.redirect === "error" || hop === 20)
				throw new TypeError("fetch failed");
			const next = new URL(location, req.url);
			const headers = new Headers(req.headers);
			if (next.origin !== new URL(req.url).origin)
				headers.delete("authorization");
			const asGet =
				res.status === 303 ||
				((res.status === 301 || res.status === 302) && req.method === "POST");
			req = new Request(next, {
				method: asGet ? "GET" : req.method,
				headers,
				body: asGet ? undefined : body,
				redirect: req.redirect,
				signal: req.signal,
			});
		}
	};
}

export function fakeDeployment(
	opts: { host?: string; name?: string } = {},
): FakeDeployment {
	const host = opts.host ?? "give.example.org";
	const state = newState(host, opts.name ?? "Give Example");
	const calls: RecordedCall[] = [];
	let interceptor: Interceptor | null = null;
	const app = deploymentApp(state);

	async function handle(req: Request): Promise<Response> {
		calls.push(await record(req));
		return (await interceptor?.(req)) ?? (await app.fetch(req));
	}

	const fake: FakeDeployment = {
		origin: `https://${host}` as Origin,
		host,
		fetch: (input, init) => fakeNetwork(fake)(input, init),
		calls,
		issuedKeys: state.issued,
		refuseKeys: () => state.keys.clear(),
		setRelease: (release) => {
			state.release = release;
		},
		setActions: (actions) => {
			state.actions = new Set(actions);
		},
		mintCode: () => mintCode(state),
		intercept: (handler) => {
			interceptor = handler;
		},
		handle,
	};
	return fake;
}

async function record(req: Request): Promise<RecordedCall> {
	const url = new URL(req.url);
	const text = await req.clone().text();
	let body: unknown = null;
	if (text !== "") {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}
	return {
		method: req.method,
		host: url.host,
		path: url.pathname,
		query: Object.fromEntries(url.searchParams),
		authorization: req.headers.get("authorization"),
		body,
	};
}

type Money = { amount: string; currency: "USD" };
type CampaignStatus = "draft" | "published" | "ended";
type Block = { type: string } & Record<string, unknown>;
type Campaign = {
	id: string;
	title: string;
	status: CampaignStatus;
	blocks: Block[];
	settings: {
		goal: Money | null;
		end_date: string | null;
		sharing: { title: string | null; description: string | null };
	};
	created_at: string;
};
type Form = { id: string } & Record<string, unknown>;
type Donor = { id: string; name: string; email: string | null };
type Donation = {
	id: string;
	amount: Money;
	date: string;
	donor_id: string;
	campaign_id: string | null;
	method: string;
	note: string | null;
};
type Recurring = {
	id: string;
	donor_id: string;
	amount: Money;
	interval: "month";
	status: "active";
	next_date: string;
};

type State = ReturnType<typeof newState>;

function newState(host: string, name: string) {
	const formId = "frm_1";
	return {
		host,
		name,
		release: "1.0.0",
		actions: new Set<string>(ALL_ACTIONS),
		keys: new Set<string>(),
		issued: [] as string[],
		// Allow codes not yet redeemed, with when each lapses
		codes: new Map<string, number>(),
		seq: 1,
		campaigns: new Map<string, Campaign>(),
		forms: new Map<string, Form>([
			[
				formId,
				{
					id: formId,
					name: "Default form",
					amounts: ["25.00", "50.00", "100.00"],
					currency: "USD",
					allow_recurring: true,
				},
			],
		]),
		donationPage: { blocks: startingBlocks(formId) },
		donors: new Map<string, Donor>(),
		donations: new Map<string, Donation>(),
		recurring: [] as Recurring[],
	};
}

const CODE_TTL_MS = 10 * 60_000;

function mintCode(state: State): string {
	const code = crypto.randomUUID();
	state.codes.set(code, Date.now() + CODE_TTL_MS);
	return code;
}

// Single-use: a redeemed code is gone whether or not it was still good.
function redeemCode(state: State, code: string): boolean {
	const lapsesAt = state.codes.get(code);
	state.codes.delete(code);
	return lapsesAt !== undefined && Date.now() < lapsesAt;
}

function startingBlocks(formId: string): Block[] {
	return [
		{ type: "hero", heading: "Support our work", subheading: null },
		{ type: "goal_meter" },
		{ type: "donate_form", form_id: formId },
	];
}

const CATALOG = [
	{
		type: "hero",
		description:
			"Large heading at the top of the page, with an optional photo.",
		schema: {
			type: "object",
			required: ["heading"],
			properties: {
				heading: { type: "string" },
				subheading: { type: ["string", "null"] },
				image_url: { type: ["string", "null"], format: "uri" },
			},
		},
	},
	{
		type: "text",
		description: "A paragraph of story text.",
		schema: {
			type: "object",
			required: ["body"],
			properties: { body: { type: "string" } },
		},
	},
	{
		type: "goal_meter",
		description: "Progress toward the campaign goal.",
		schema: { type: "object", properties: {} },
	},
	{
		type: "donate_form",
		description: "The donation form.",
		schema: {
			type: "object",
			required: ["form_id"],
			properties: { form_id: { type: "string" } },
		},
	},
];
const BLOCK_TYPES = new Set(CATALOG.map((b) => b.type));

const money = z.object({
	amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
	currency: z.literal("USD"),
});
const date = z.iso.date();
const blocks = z.object({
	blocks: z.array(
		z
			.object({
				type: z
					.string()
					.refine((t) => BLOCK_TYPES.has(t), "unknown block type"),
			})
			.loose(),
	),
});
const bodies = {
	createCampaign: z.object({ title: z.string().trim().min(1).max(120) }),
	settings: z.object({
		goal: money.nullable().optional(),
		end_date: date.nullable().optional(),
		sharing: z
			.object({
				title: z.string().nullable().optional(),
				description: z.string().nullable().optional(),
			})
			.optional(),
	}),
	createForm: z.object({ name: z.string().trim().min(1) }).loose(),
	updateForm: z.object({ name: z.string().trim().min(1).optional() }).loose(),
	recordDonation: z.object({
		amount: money,
		date,
		donor: z.object({
			name: z.string().trim().min(1),
			email: z.email().optional(),
		}),
		campaign_id: z.string().optional(),
		method: z.enum(["cash", "check", "bank_transfer", "other"]),
		note: z.string().optional(),
	}),
	uploadLink: z.object({
		target: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("campaign"), id: z.string() }),
			z.object({ kind: z.literal("donation_page") }),
		]),
		slot: z.string().optional(),
	}),
};

function problem(
	c: Context,
	status: ContentfulStatusCode,
	code: string,
	detail: string,
	errors?: { path: string; message: string }[],
) {
	const body = {
		type: "about:blank",
		title: code,
		status,
		detail,
		code,
		errors,
	};
	return c.body(JSON.stringify(body), status, {
		"content-type": "application/problem+json",
	});
}

async function parse<T extends z.ZodType>(
	c: Context,
	schema: T,
): Promise<{ ok: true; data: z.output<T> } | { ok: false; res: Response }> {
	const raw: unknown = await c.req.json().catch(() => undefined);
	const parsed = schema.safeParse(raw);
	if (parsed.success) return { ok: true, data: parsed.data };
	// Assumption pending the contract: it names `errors: [{ path, message }]`
	// and no status or path syntax. 422 and dotted paths are this fake's own.
	const errors = parsed.error.issues.map((i) => ({
		path: i.path.join("."),
		message: i.message,
	}));
	return {
		ok: false,
		res: problem(
			c,
			422,
			"validation_failed",
			"The request body is invalid.",
			errors,
		),
	};
}

function page<T>(c: Context, items: T[]) {
	const start = Number(c.req.query("cursor") ?? 0) || 0;
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 100);
	const end = start + limit;
	return c.json({
		data: items.slice(start, end),
		next_cursor: end < items.length ? String(end) : null,
	});
}

const toCents = (m: Money) => Math.round(Number(m.amount) * 100);
const fromCents = (cents: number): Money => ({
	amount: (cents / 100).toFixed(2),
	currency: "USD",
});
const sum = (ds: Donation[]) =>
	fromCents(ds.reduce((n, d) => n + toCents(d.amount), 0));

function deploymentApp(state: State) {
	const nextId = (prefix: string) => `${prefix}_${state.seq++}`;
	const publicUrl = (path: string) => `https://${state.host}${path}`;
	const campaignView = (k: Campaign) => ({
		...k,
		public_url: publicUrl(`/campaigns/${k.id}`),
		raised: sum(
			[...state.donations.values()].filter((d) => d.campaign_id === k.id),
		),
	});
	const donorView = (d: Donor) => {
		const gifts = [...state.donations.values()].filter(
			(g) => g.donor_id === d.id,
		);
		return { ...d, total: sum(gifts), gift_count: gifts.length };
	};
	const inRange = (d: Donation, from?: string, to?: string) =>
		(!from || d.date >= from) && (!to || d.date <= to);

	const action =
		(name: string): MiddlewareHandler =>
		async (c, next) => {
			if (!state.actions.has(name)) {
				return problem(
					c,
					404,
					"unknown_action",
					`This release has no ${name}.`,
				);
			}
			await next();
		};

	const findCampaign = (c: Context) => {
		const k = state.campaigns.get(c.req.param("id") ?? "");
		return k ?? problem(c, 404, "not_found", "No campaign has that id.");
	};
	const transition = (
		name: string,
		from: CampaignStatus[],
		to: CampaignStatus,
	) =>
		[
			action(name),
			(c: Context) => {
				const k = findCampaign(c);
				if (k instanceof Response) return k;
				// Assumption pending the contract: it names no status for a refused
				// transition. 409 `invalid_state` is this fake's own.
				if (!from.includes(k.status)) {
					return problem(
						c,
						409,
						"invalid_state",
						`A ${k.status} campaign cannot do that.`,
					);
				}
				k.status = to;
				return c.json(campaignView(k));
			},
		] as const;

	const app = new Hono();

	// Stands in for a signed-in operator pressing Allow, or Deny with `press=deny`.
	app.get("/admin/connector/allow", (c) => {
		const back = new URL(RETURN_URL);
		back.searchParams.set("state", c.req.query("state") ?? "");
		if (c.req.query("press") === "deny") {
			back.searchParams.set("error", "access_denied");
		} else {
			back.searchParams.set("code", mintCode(state));
		}
		return c.redirect(back.href, 302);
	});

	const v1 = new Hono();

	// Registered ahead of the key check below, which therefore never runs for them.
	v1.get("/hello", (c) =>
		c.json({
			service: "better-giving",
			contract: 1,
			release: state.release,
			name: state.name,
			actions: [...state.actions],
		}),
	);
	v1.post("/exchange", async (c) => {
		const body: unknown = await c.req.json().catch(() => undefined);
		const code = z.object({ code: z.string() }).safeParse(body).data?.code;
		if (!code || !redeemCode(state, code)) {
			return problem(
				c,
				400,
				"code_invalid",
				"That code is used, expired or unknown.",
			);
		}
		const key = `bgk_${crypto.randomUUID()}`;
		state.keys.add(key);
		state.issued.push(key);
		return c.json({ key, name: state.name });
	});

	v1.use(async (c, next) => {
		const [scheme, key] = (c.req.header("authorization") ?? "").split(" ");
		if (scheme !== "Bearer" || !key || !state.keys.has(key)) {
			return problem(
				c,
				401,
				"key_refused",
				"This connector key is not accepted.",
			);
		}
		await next();
	});

	v1.get("/campaigns", action("campaigns.list"), (c) => {
		const status = c.req.query("status");
		const all = [...state.campaigns.values()].filter(
			(k) => !status || k.status === status,
		);
		return page(
			c,
			all.map((k) => {
				const { id, title, status, public_url, raised } = campaignView(k);
				return { id, title, status, public_url, raised };
			}),
		);
	});
	v1.post("/campaigns", action("campaigns.create"), async (c) => {
		const body = await parse(c, bodies.createCampaign);
		if (!body.ok) return body.res;
		const id = nextId("cmp");
		const k: Campaign = {
			id,
			title: body.data.title,
			status: "draft",
			blocks: startingBlocks("frm_1"),
			settings: {
				goal: null,
				end_date: null,
				sharing: { title: null, description: null },
			},
			created_at: new Date().toISOString(),
		};
		state.campaigns.set(id, k);
		return c.json(campaignView(k), 201);
	});
	v1.get("/campaigns/:id", action("campaigns.get"), (c) => {
		const k = findCampaign(c);
		return k instanceof Response ? k : c.json(campaignView(k));
	});
	v1.patch(
		"/campaigns/:id/blocks",
		action("campaigns.update_blocks"),
		async (c) => {
			const k = findCampaign(c);
			if (k instanceof Response) return k;
			const body = await parse(c, blocks);
			if (!body.ok) return body.res;
			k.blocks = body.data.blocks;
			return c.json(campaignView(k));
		},
	);
	v1.patch(
		"/campaigns/:id/settings",
		action("campaigns.update_settings"),
		async (c) => {
			const k = findCampaign(c);
			if (k instanceof Response) return k;
			const body = await parse(c, bodies.settings);
			if (!body.ok) return body.res;
			const { goal, end_date, sharing } = body.data;
			if (goal !== undefined) k.settings.goal = goal;
			if (end_date !== undefined) k.settings.end_date = end_date;
			if (sharing) k.settings.sharing = { ...k.settings.sharing, ...sharing };
			return c.json(campaignView(k));
		},
	);
	v1.post(
		"/campaigns/:id/publish",
		...transition("campaigns.publish", ["draft"], "published"),
	);
	v1.post(
		"/campaigns/:id/unpublish",
		...transition("campaigns.unpublish", ["published"], "draft"),
	);
	v1.post(
		"/campaigns/:id/end",
		...transition("campaigns.end", ["draft", "published"], "ended"),
	);

	const pageView = () => ({
		...state.donationPage,
		public_url: publicUrl("/donate"),
	});
	v1.get("/donation-page", action("donation_page.get"), (c) =>
		c.json(pageView()),
	);
	v1.patch(
		"/donation-page/blocks",
		action("donation_page.update_blocks"),
		async (c) => {
			const body = await parse(c, blocks);
			if (!body.ok) return body.res;
			state.donationPage.blocks = body.data.blocks;
			return c.json(pageView());
		},
	);
	v1.post("/donation-page/reset", action("donation_page.reset"), (c) => {
		state.donationPage.blocks = startingBlocks("frm_1");
		return c.json(pageView());
	});
	v1.get("/blocks/catalog", action("blocks.catalog"), (c) =>
		c.json({ blocks: CATALOG }),
	);

	const findForm = (c: Context) =>
		state.forms.get(c.req.param("id") ?? "") ??
		problem(c, 404, "not_found", "No form has that id.");
	v1.get("/forms", action("forms.list"), (c) =>
		page(c, [...state.forms.values()]),
	);
	v1.get("/forms/:id", action("forms.get"), (c) => {
		const f = findForm(c);
		return f instanceof Response ? f : c.json(f);
	});
	v1.post("/forms", action("forms.create"), async (c) => {
		const body = await parse(c, bodies.createForm);
		if (!body.ok) return body.res;
		const f: Form = {
			amounts: [],
			currency: "USD",
			allow_recurring: false,
			...body.data,
			id: nextId("frm"),
		};
		state.forms.set(f.id, f);
		return c.json(f, 201);
	});
	v1.patch("/forms/:id", action("forms.update"), async (c) => {
		const f = findForm(c);
		if (f instanceof Response) return f;
		const body = await parse(c, bodies.updateForm);
		if (!body.ok) return body.res;
		Object.assign(f, body.data, { id: f.id });
		return c.json(f);
	});

	v1.get("/results", action("results.summary"), (c) => {
		const { campaign_id, from, to } = c.req.query();
		const gifts = [...state.donations.values()].filter(
			(d) =>
				(!campaign_id || d.campaign_id === campaign_id) && inRange(d, from, to),
		);
		return c.json({
			total: sum(gifts),
			gift_count: gifts.length,
			donor_count: new Set(gifts.map((d) => d.donor_id)).size,
			campaigns: [...state.campaigns.values()]
				.filter((k) => !campaign_id || k.id === campaign_id)
				.map((k) => ({
					id: k.id,
					title: k.title,
					total: sum(gifts.filter((d) => d.campaign_id === k.id)),
				})),
		});
	});
	v1.get("/donations", action("donations.list"), (c) => {
		const { campaign_id, from, to } = c.req.query();
		return page(
			c,
			[...state.donations.values()].filter(
				(d) =>
					(!campaign_id || d.campaign_id === campaign_id) &&
					inRange(d, from, to),
			),
		);
	});
	v1.post("/donations", action("donations.record"), async (c) => {
		const body = await parse(c, bodies.recordDonation);
		if (!body.ok) return body.res;
		const { donor, campaign_id, note, ...rest } = body.data;
		if (campaign_id && !state.campaigns.has(campaign_id)) {
			return problem(c, 404, "not_found", "No campaign has that id.");
		}
		const known = [...state.donors.values()].find((d) =>
			donor.email ? d.email === donor.email : d.name === donor.name,
		);
		const who = known ?? {
			id: nextId("dnr"),
			name: donor.name,
			email: donor.email ?? null,
		};
		state.donors.set(who.id, who);
		const gift: Donation = {
			...rest,
			id: nextId("don"),
			donor_id: who.id,
			campaign_id: campaign_id ?? null,
			note: note ?? null,
		};
		state.donations.set(gift.id, gift);
		return c.json(gift, 201);
	});
	v1.get("/donors", action("donors.list"), (c) => {
		const q = c.req.query("q")?.toLowerCase();
		const hits = [...state.donors.values()].filter(
			(d) =>
				!q ||
				d.name.toLowerCase().includes(q) ||
				d.email?.toLowerCase().includes(q),
		);
		return page(c, hits.map(donorView));
	});
	v1.get("/donors/:id", action("donors.get"), (c) => {
		const d = state.donors.get(c.req.param("id"));
		if (!d) return problem(c, 404, "not_found", "No donor has that id.");
		const gifts = [...state.donations.values()].filter(
			(g) => g.donor_id === d.id,
		);
		return c.json({ ...donorView(d), gifts });
	});
	v1.get("/recurring", action("recurring.list"), (c) =>
		page(c, state.recurring),
	);
	v1.post("/photos/upload-link", action("photos.upload_link"), async (c) => {
		const body = await parse(c, bodies.uploadLink);
		if (!body.ok) return body.res;
		const { target } = body.data;
		if (target.kind === "campaign" && !state.campaigns.has(target.id)) {
			return problem(c, 404, "not_found", "No campaign has that id.");
		}
		// Assumption pending the contract: it says "short-lived", not how short.
		return c.json({
			url: publicUrl(`/uploads/${crypto.randomUUID()}`),
			expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
		});
	});

	app.route("/connector/v1", v1);
	// A sub-app's notFound never runs under route(); this one covers both.
	app.notFound((c) =>
		c.req.path.startsWith("/connector/v1/")
			? problem(c, 404, "unknown_action", "This release has no such action.")
			: c.text("Not Found", 404),
	);
	return app;
}
