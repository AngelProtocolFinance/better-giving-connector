import { afterEach, describe, expect, test, vi } from "vitest";
import {
	ALL_ACTIONS,
	fakeDeployment,
	MVP_ACTIONS,
	STANDALONE_ACTIONS,
} from "./fake-deployment";
import { advance, MINUTE } from "./support";

// The fake is the only `/connector/v1` the connector is checked against until
// better-giving-oss ships it, so where contract.md says something these pin the
// fake to the document, over the wire.

afterEach(() => {
	vi.useRealTimers();
});

const V1 = "/connector/v1";

describe("the Allow code", () => {
	const exchange = (dep: ReturnType<typeof fakeDeployment>, code: string) =>
		dep.fetch(`${dep.origin}${V1}/exchange`, {
			method: "POST",
			body: JSON.stringify({ code }),
		});

	async function expectCodeInvalid(res: Response) {
		expect(res.status).toBe(400);
		expect(res.headers.get("content-type")).toBe("application/problem+json");
		expect(await res.json()).toMatchObject({
			status: 400,
			code: "code_invalid",
		});
	}

	test("is redeemed for a key and a name, once", async () => {
		const dep = fakeDeployment({ name: "Hope Shelter" });
		const code = dep.mintCode();

		const first = await exchange(dep, code);
		const again = await exchange(dep, code);

		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			key: dep.issuedKeys[0],
			name: "Hope Shelter",
		});
		await expectCodeInvalid(again);
		expect(dep.issuedKeys).toHaveLength(1);
	});

	test.each([
		["Allow", ""],
		["Deny", "&press=deny"],
	])("comes back from %s naming its issuer", async (_, press) => {
		const dep = fakeDeployment({ host: "hope.example.org" });

		const res = await dep.fetch(
			`${dep.origin}/admin/connector/allow?state=s1${press}`,
			{ redirect: "manual" },
		);

		const back = new URL(res.headers.get("location") ?? "");
		expect(back.searchParams.get("iss")).toBe("https://hope.example.org");
		expect(back.searchParams.get("state")).toBe("s1");
	});

	test("holds for 10 minutes", async () => {
		const dep = fakeDeployment();
		const code = dep.mintCode();
		advance(10 * MINUTE - 1000);

		const res = await exchange(dep, code);

		expect(res.status).toBe(200);
	});

	test("is refused after 10 minutes and leaves no key behind", async () => {
		const dep = fakeDeployment();
		const code = dep.mintCode();
		advance(10 * MINUTE + 1000);

		await expectCodeInvalid(await exchange(dep, code));

		expect(dep.issuedKeys).toEqual([]);
	});

	test.each([
		["unknown", "never-minted"],
		["empty", ""],
	])("is refused when %s", async (_, code) => {
		const dep = fakeDeployment();

		await expectCodeInvalid(await exchange(dep, code));
	});
});

describe("a key", () => {
	async function connected() {
		const dep = fakeDeployment();
		const res = await dep.fetch(`${dep.origin}${V1}/exchange`, {
			method: "POST",
			body: JSON.stringify({ code: dep.mintCode() }),
		});
		const { key } = (await res.json()) as { key: string };
		const get = (authorization?: string) =>
			dep.fetch(`${dep.origin}${V1}/campaigns`, {
				headers: authorization ? { authorization } : {},
			});
		return { dep, key, get };
	}

	async function expectKeyRefused(res: Response) {
		expect(res.status).toBe(401);
		expect(res.headers.get("content-type")).toBe("application/problem+json");
		expect(await res.json()).toMatchObject({
			status: 401,
			code: "key_refused",
		});
	}

	test("the one /exchange handed out is accepted", async () => {
		const { key, get } = await connected();

		expect((await get(`Bearer ${key}`)).status).toBe(200);
	});

	test.each([
		["no Authorization header", () => undefined],
		["a key of another kind", () => "Bearer sk_live_not_a_connector_key"],
		["a connector key under another scheme", (key: string) => `Token ${key}`],
		["a connector key with a letter added", (key: string) => `Bearer ${key}x`],
	])("%s is 401 key_refused", async (_, header) => {
		const { key, get } = await connected();

		await expectKeyRefused(await get(header(key)));
	});

	test("a revoked key is 401 key_refused", async () => {
		const { dep, key, get } = await connected();
		dep.refuseKeys();

		await expectKeyRefused(await get(`Bearer ${key}`));
	});

	test("is not asked for by /hello", async () => {
		const dep = fakeDeployment();

		const res = await dep.fetch(`${dep.origin}${V1}/hello`);

		expect(res.status).toBe(200);
	});
});

describe("record-gift method", () => {
	const GIFT = {
		amount: { amount: "40.00", currency: "USD" },
		date: "2026-10-01",
		donor: { name: "Ada Park" },
	};

	async function record(method: unknown) {
		const dep = fakeDeployment();
		const exchanged = await dep.fetch(`${dep.origin}${V1}/exchange`, {
			method: "POST",
			body: JSON.stringify({ code: dep.mintCode() }),
		});
		const { key } = (await exchanged.json()) as { key: string };
		return dep.fetch(`${dep.origin}${V1}/donations`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}` },
			body: JSON.stringify({ ...GIFT, method }),
		});
	}

	test.each(["cash", "check"])("%s is recorded", async (method) => {
		const res = await record(method);

		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ method, campaign_id: null });
	});

	test.each(["bank_transfer", "other"])(
		"%s is refused: this deployment records cash or check",
		async (method) => {
			const res = await record(method);

			expect(res.status).toBe(422);
			expect(await res.json()).toMatchObject({
				code: "validation_failed",
				errors: [{ path: "method" }],
			});
		},
	);

	test("campaign_id is refused", async () => {
		const dep = fakeDeployment();
		const exchanged = await dep.fetch(`${dep.origin}${V1}/exchange`, {
			method: "POST",
			body: JSON.stringify({ code: dep.mintCode() }),
		});
		const { key } = (await exchanged.json()) as { key: string };
		const res = await dep.fetch(`${dep.origin}${V1}/donations`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}` },
			body: JSON.stringify({ ...GIFT, method: "cash", campaign_id: "cmp_1" }),
		});

		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			errors: [{ path: "campaign_id" }],
		});
	});

	test.each([
		["a method outside the contract", "venmo"],
		["a method in another case", "Cash"],
		["an empty method", ""],
		["no method", undefined],
	])("%s is refused with the field named", async (_, method) => {
		const res = await record(method);

		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			code: "validation_failed",
			errors: [{ path: "method" }],
		});
	});
});

describe("action presets", () => {
	test("ALL, STANDALONE and MVP are the three releases", () => {
		expect(ALL_ACTIONS).toHaveLength(23);
		expect(new Set(ALL_ACTIONS).size).toBe(23);
		expect(STANDALONE_ACTIONS).toHaveLength(22);
		expect(STANDALONE_ACTIONS).not.toContain("campaigns.unpublish");
		expect(MVP_ACTIONS).toEqual([
			"campaigns.list",
			"campaigns.get",
			"donation_page.get",
			"blocks.catalog",
			"forms.list",
			"forms.get",
			"results.summary",
			"donations.list",
			"donors.list",
			"donors.get",
			"recurring.list",
			"campaigns.create",
			"donations.record",
		]);
	});
});

describe("unknown method or path", () => {
	test("is a 404 problem of type unknown_action", async () => {
		const dep = fakeDeployment();
		const exchanged = await dep.fetch(`${dep.origin}${V1}/exchange`, {
			method: "POST",
			body: JSON.stringify({ code: dep.mintCode() }),
		});
		const { key } = (await exchanged.json()) as { key: string };
		const res = await dep.fetch(`${dep.origin}${V1}/no-such-action`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}` },
		});

		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toBe("application/problem+json");
		expect(await res.json()).toMatchObject({
			type: "https://better.giving/connector/problems/unknown_action",
			code: "unknown_action",
		});
	});

	test("a known path with the wrong method is the same problem", async () => {
		const dep = fakeDeployment();
		const res = await dep.fetch(`${dep.origin}${V1}/hello`, { method: "POST" });

		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: "unknown_action" });
	});
});

describe("Idempotency-Key", () => {
	async function authed() {
		const dep = fakeDeployment();
		const exchanged = await dep.fetch(`${dep.origin}${V1}/exchange`, {
			method: "POST",
			body: JSON.stringify({ code: dep.mintCode() }),
		});
		const { key } = (await exchanged.json()) as { key: string };
		const post = (path: string, body: unknown, idempotencyKey?: string) =>
			dep.fetch(`${dep.origin}${V1}${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${key}`,
					...(idempotencyKey === undefined
						? {}
						: { "idempotency-key": idempotencyKey }),
				},
				body: JSON.stringify(body),
			});
		return { dep, post };
	}

	test("the first call is 201 and the same key and body replay as 200", async () => {
		const { dep, post } = await authed();
		const gift = {
			amount: { amount: "10.00", currency: "USD" },
			date: "2026-10-02",
			donor: { name: "Bea" },
			method: "cash",
		};

		const first = await post("/donations", gift, "gift-1");
		const again = await post("/donations", gift, "gift-1");

		expect(first.status).toBe(201);
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual(await first.json());
		expect(
			dep.calls.filter((call) => call.path.endsWith("/donations")),
		).toHaveLength(2);
		const listed = await dep.fetch(`${dep.origin}${V1}/donations`, {
			headers: {
				authorization:
					dep.calls.find((call) => call.path.endsWith("/donations"))
						?.authorization ?? "",
			},
		});
		expect(await listed.json()).toMatchObject({ data: [{ method: "cash" }] });
	});

	test("the same key with a different body is 409 idempotency_conflict", async () => {
		const { post } = await authed();
		const gift = {
			amount: { amount: "10.00", currency: "USD" },
			date: "2026-10-02",
			donor: { name: "Bea" },
			method: "cash",
		};

		expect((await post("/donations", gift, "gift-1")).status).toBe(201);
		const clash = await post(
			"/donations",
			{ ...gift, note: "second" },
			"gift-1",
		);

		expect(clash.status).toBe(409);
		expect(await clash.json()).toMatchObject({ code: "idempotency_conflict" });
	});
});

describe("publish and reset", () => {
	async function authed() {
		const dep = fakeDeployment();
		const exchanged = await dep.fetch(`${dep.origin}${V1}/exchange`, {
			method: "POST",
			body: JSON.stringify({ code: dep.mintCode() }),
		});
		const { key } = (await exchanged.json()) as { key: string };
		const send = (path: string, method: string, body?: unknown) =>
			dep.fetch(`${dep.origin}${V1}${path}`, {
				method,
				headers: { authorization: `Bearer ${key}` },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		return { send };
	}

	test("the first publish without gifts_go_to is refused", async () => {
		const { send } = await authed();
		const made = await send("/campaigns", "POST", { title: "Coats" });
		const { id } = (await made.json()) as { id: string };

		const res = await send(`/campaigns/${id}/publish`, "POST", {});

		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			errors: [{ path: "gifts_go_to" }],
		});
	});

	test("reset without confirm true is refused", async () => {
		const { send } = await authed();

		const res = await send("/donation-page/reset", "POST", {});

		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			errors: [{ path: "confirm" }],
		});
	});
});
