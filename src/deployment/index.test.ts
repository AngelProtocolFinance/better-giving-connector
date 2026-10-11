import { inspect } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	type FakeDeployment,
	fakeDeployment,
	fakeNetwork,
	hang,
} from "../../test/fake-deployment";
import { Secret } from "../secret";
import {
	type ActionName,
	CodeInvalid,
	DeploymentRejected,
	deploymentClient,
	KeyRefused,
	NeedsUpdate,
	Unreachable,
} from "./index";

describe("hello", () => {
	test("reads the release, org name and known actions without sending a key", async () => {
		const dep = fakeDeployment({ name: "Hope Shelter" });
		dep.setRelease("3.4.0");
		dep.setActions(["campaigns.list", "campaigns.get", "something.newer"]);
		const client = deploymentClient({ fetch: dep.fetch });

		expect(await client.hello(dep.origin)).toEqual({
			release: "3.4.0",
			orgName: "Hope Shelter",
			actions: ["campaigns.list", "campaigns.get"],
		});
		expect(dep.calls).toMatchObject([
			{ method: "GET", path: "/connector/v1/hello", authorization: null },
		]);
	});

	const helloBody = {
		service: "better-giving",
		contract: 1,
		release: "1.0.0",
		name: "Give Example",
		actions: [],
	};
	test.each([
		[
			"a 404 (no /connector/v1)",
			() => new Response("<h1>Not Found</h1>", { status: 404 }),
		],
		["a non-JSON 200", () => new Response("<!doctype html><p>a shop</p>")],
		[
			"another service",
			() => Response.json({ ...helloBody, service: "shopify" }),
		],
		["another contract", () => Response.json({ ...helloBody, contract: 2 })],
	])("is NeedsUpdate on %s", async (_, answer) => {
		const dep = fakeDeployment();
		dep.intercept(answer);
		const client = deploymentClient({ fetch: dep.fetch });

		await expect(client.hello(dep.origin)).rejects.toBeInstanceOf(NeedsUpdate);
	});
});

test("allowUrl sends the browser to the deployment's Allow screen with the state", () => {
	const dep = fakeDeployment();
	const client = deploymentClient({ fetch: dep.fetch });
	const url = client.allowUrl(dep.origin, "st/1&x");

	expect(url.href).toBe(
		"https://give.example.org/admin/connector/allow?state=st%2F1%26x",
	);
});

describe("exchange", () => {
	test("trades an Allow code for the key, once, without sending a key", async () => {
		const dep = fakeDeployment();
		const client = deploymentClient({ fetch: dep.fetch });
		const code = dep.mintCode();

		const key = await client.exchange(dep.origin, code);

		expect(key).toBeInstanceOf(Secret);
		expect(dep.calls).toMatchObject([
			{
				method: "POST",
				path: "/connector/v1/exchange",
				authorization: null,
				body: { code },
			},
		]);
		await expect(client.exchange(dep.origin, code)).rejects.toBeInstanceOf(
			CodeInvalid,
		);
	});
});

async function connected(dep: FakeDeployment, fetch = dep.fetch) {
	const client = deploymentClient({ fetch });
	const key = await client.exchange(dep.origin, dep.mintCode());
	dep.calls.length = 0;
	return { client, conn: { origin: dep.origin, key } };
}

describe("call", () => {
	test("sends the key as a bearer to the connection's origin and nowhere else", async () => {
		const a = fakeDeployment({ host: "a.example.org" });
		const b = fakeDeployment({ host: "b.example.org" });
		const { client, conn } = await connected(a, fakeNetwork(a, b));

		const hostile = client.call(conn, "campaigns.get", {
			id: "//b.example.org/connector/v1/campaigns",
		});

		await expect(hostile).rejects.toMatchObject({
			name: "DeploymentRejected",
			status: 404,
		});
		expect(a.calls).toMatchObject([
			{
				host: "a.example.org",
				path: "/connector/v1/campaigns/%2F%2Fb.example.org%2Fconnector%2Fv1%2Fcampaigns",
				authorization: `Bearer ${conn.key.reveal()}`,
			},
		]);
		expect(b.calls).toEqual([]);
	});

	test("answers with the deployment's JSON body", async () => {
		const dep = fakeDeployment();
		const { client, conn } = await connected(dep);

		const made = await client.call(conn, "campaigns.create", {
			title: "Winter coats",
		});

		expect(made).toMatchObject({ title: "Winter coats", status: "draft" });
	});

	test("takes path params out of the input, sends the rest as query on GET", async () => {
		const dep = fakeDeployment();
		const { client, conn } = await connected(dep);

		await client.call(conn, "donations.list", {
			campaign_id: "cmp_9",
			from: "2026-01-01",
			to: undefined,
		});

		expect(dep.calls).toMatchObject([
			{
				method: "GET",
				path: "/connector/v1/donations",
				query: { campaign_id: "cmp_9", from: "2026-01-01" },
				body: null,
			},
		]);
		expect(dep.calls[0]?.query).not.toHaveProperty("to");
	});

	test("takes path params out of the input, sends the rest as a JSON body otherwise", async () => {
		const dep = fakeDeployment();
		const { client, conn } = await connected(dep);
		const goal = { amount: "5000.00", currency: "USD" };
		const { id } = (await client.call(conn, "campaigns.create", {
			title: "Coats",
		})) as { id: string };

		const updated = await client.call(conn, "campaigns.update_settings", {
			id,
			goal,
		});

		expect(dep.calls.at(-1)).toMatchObject({
			method: "PATCH",
			path: `/connector/v1/campaigns/${id}/settings`,
			query: {},
			body: { goal },
		});
		expect(updated).toMatchObject({ id, settings: { goal } });
	});
});

describe("call maps the deployment's answer", () => {
	test("a refused key is KeyRefused", async () => {
		const dep = fakeDeployment();
		const { client, conn } = await connected(dep);
		dep.refuseKeys();

		await expect(
			client.call(conn, "campaigns.list", {}),
		).rejects.toBeInstanceOf(KeyRefused);
	});

	test("a missing resource is DeploymentRejected with the problem body", async () => {
		const dep = fakeDeployment();
		const { client, conn } = await connected(dep);

		const err = await client
			.call(conn, "donors.get", { id: "dnr_404" })
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(DeploymentRejected);
		expect(err).toMatchObject({ status: 404, body: { code: "not_found" } });
	});

	test("an action the release lacks is NeedsUpdate", async () => {
		const dep = fakeDeployment();
		const { client, conn } = await connected(dep);
		dep.setActions(["campaigns.list"]);

		await expect(
			client.call(conn, "photos.upload_link", {
				target: { kind: "donation_page" },
			}),
		).rejects.toBeInstanceOf(NeedsUpdate);
	});

	test("a release with no /connector/v1 is NeedsUpdate", async () => {
		const dep = fakeDeployment();
		const { client, conn } = await connected(dep);
		dep.intercept(() => new Response("<h1>Not Found</h1>", { status: 404 }));

		await expect(
			client.call(conn, "campaigns.list", {}),
		).rejects.toBeInstanceOf(NeedsUpdate);
	});

	test("any other 4xx is DeploymentRejected with its status and body", async () => {
		const dep = fakeDeployment();
		const { client, conn } = await connected(dep);

		const err = await client
			.call(conn, "campaigns.create", { title: "" })
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(DeploymentRejected);
		expect(err).toMatchObject({
			status: 422,
			body: { code: "validation_failed", errors: [{ path: "title" }] },
		});
	});

	test.each([
		["a 5xx", () => Response.json({ code: "oops" }, { status: 503 })],
		["a non-JSON success", () => new Response("<!doctype html>")],
		[
			"a network failure",
			() => {
				throw new TypeError("fetch failed");
			},
		],
	])("%s is Unreachable", async (_, answer) => {
		const dep = fakeDeployment();
		const { client, conn } = await connected(dep);
		dep.intercept(answer);

		await expect(
			client.call(conn, "campaigns.list", {}),
		).rejects.toBeInstanceOf(Unreachable);
	});
});

test("a redirect is refused, so the request never reaches its target", async () => {
	const a = fakeDeployment({ host: "a.example.org" });
	const b = fakeDeployment({ host: "b.example.org" });
	const { client, conn } = await connected(a, fakeNetwork(a, b));
	a.intercept(() =>
		Response.redirect("https://b.example.org/connector/v1/forms", 307),
	);

	await expect(client.call(conn, "forms.list", {})).rejects.toBeInstanceOf(
		Unreachable,
	);
	expect(b.calls).toEqual([]);
});

describe("timeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("a deployment silent for 15 s is Unreachable", async () => {
		const dep = fakeDeployment();
		const { client, conn } = await connected(dep);
		vi.useFakeTimers();
		dep.intercept(hang);
		let outcome: unknown = "pending";
		const pending = client
			.call(conn, "campaigns.list", {})
			.catch((e: unknown) => {
				outcome = e;
			});

		await vi.advanceTimersByTimeAsync(14_999);
		expect(outcome).toBe("pending");
		await vi.advanceTimersByTimeAsync(1);
		await pending;
		expect(outcome).toBeInstanceOf(Unreachable);
	});
});

describe("no error carries the key, the input or the response", () => {
	const KEY = "KEY-SENTINEL-5be1";
	const INPUT = "INPUT-SENTINEL-93c0";
	const RESPONSE = "RESPONSE-SENTINEL-d71e";
	const problem = (status: number, code: string) =>
		Response.json(
			{ status, code, title: RESPONSE, detail: RESPONSE },
			{ status },
		);

	const outcomes: [string, (req: Request) => Response][] = [
		["KeyRefused", () => problem(401, "key_refused")],
		["NeedsUpdate", () => problem(404, "unknown_action")],
		["DeploymentRejected", () => problem(422, "validation_failed")],
		["Unreachable", () => new Response(RESPONSE, { status: 500 })],
		["Unreachable", () => new Response(RESPONSE)],
		[
			"Unreachable",
			(req) => {
				throw new TypeError(`fetch failed: ${req.url} ${RESPONSE}`);
			},
		],
	];

	function expectClean(err: unknown) {
		const e = err as Error;
		const renderings = [
			String(e),
			e.message,
			e.stack,
			JSON.stringify(e),
			inspect(e),
			String(e.cause),
		];
		for (const text of renderings) {
			for (const sentinel of [KEY, INPUT, RESPONSE])
				expect(text).not.toContain(sentinel);
		}
	}

	test.each([
		["a GET", "donors.get", { id: INPUT, q: INPUT }],
		[
			"a PATCH",
			"campaigns.update_settings",
			{ id: INPUT, sharing: { title: INPUT } },
		],
	] as const)("on %s", async (_, action, input) => {
		for (const [name, answer] of outcomes) {
			const dep = fakeDeployment();
			dep.intercept(answer);
			const client = deploymentClient({ fetch: dep.fetch });

			const err = await client
				.call({ origin: dep.origin, key: new Secret(KEY) }, action, input)
				.catch((e: unknown) => e);

			expect(err).toMatchObject({ name });
			expect(JSON.stringify(dep.calls)).toContain(INPUT);
			expectClean(err);
		}
	});

	test("while DeploymentRejected still hands the body to its caller", async () => {
		const dep = fakeDeployment();
		dep.intercept(() => problem(422, "validation_failed"));
		const client = deploymentClient({ fetch: dep.fetch });

		const err = await client
			.call({ origin: dep.origin, key: new Secret(KEY) }, "donors.list", {
				q: INPUT,
			})
			.catch((e: unknown) => e);

		expect(err).toMatchObject({ body: { detail: RESPONSE } });
	});

	test("on exchange and hello", async () => {
		const dep = fakeDeployment();
		const client = deploymentClient({ fetch: dep.fetch });

		dep.intercept(() => problem(400, "code_invalid"));
		const refused = await client
			.exchange(dep.origin, INPUT)
			.catch((e: unknown) => e);
		dep.intercept(() => Response.json({ service: RESPONSE }));
		const notOurs = await client.hello(dep.origin).catch((e: unknown) => e);

		expect(refused).toBeInstanceOf(CodeInvalid);
		expect(notOurs).toBeInstanceOf(NeedsUpdate);
		expectClean(refused);
		expectClean(notOurs);
	});
});

test("every action the fake deployment lists answers through call", async () => {
	const dep = fakeDeployment();
	const { client, conn } = await connected(dep);
	const hello = await client.hello(dep.origin);
	const usd = (amount: string) => ({ amount, currency: "USD" });
	const { id } = (await client.call(conn, "campaigns.create", {
		title: "Coats",
	})) as { id: string };
	const { id: formId } = (await client.call(conn, "forms.create", {
		name: "Gala",
	})) as { id: string };
	const gift = {
		amount: usd("40.00"),
		date: "2026-10-01",
		donor: { name: "Ana" },
		campaign_id: id,
		method: "cash",
	};
	const { donor_id } = (await client.call(conn, "donations.record", gift)) as {
		donor_id: string;
	};
	const blocks = [{ type: "text", body: "Warm hands." }];
	const inputs: Record<ActionName, Record<string, unknown>> = {
		"campaigns.list": { status: "draft" },
		"campaigns.get": { id },
		"campaigns.create": { title: "Second" },
		"campaigns.update_blocks": { id, blocks },
		"campaigns.update_settings": {
			id,
			goal: usd("500.00"),
			end_date: "2026-12-31",
		},
		"campaigns.publish": { id },
		"campaigns.unpublish": { id },
		"campaigns.end": { id },
		"donation_page.get": {},
		"donation_page.update_blocks": { blocks },
		"donation_page.reset": {},
		"blocks.catalog": {},
		"forms.list": {},
		"forms.get": { id: formId },
		"forms.create": { name: "Third" },
		"forms.update": { id: formId, name: "Gala 2026" },
		"results.summary": { campaign_id: id },
		"donations.list": { campaign_id: id },
		"donors.list": { q: "an" },
		"donors.get": { id: donor_id },
		"recurring.list": {},
		"donations.record": gift,
		"photos.upload_link": { target: { kind: "campaign", id } },
	};

	for (const action of hello.actions) {
		await expect(
			client.call(conn, action, inputs[action]),
			action,
		).resolves.toBeTypeOf("object");
	}
	expect(hello.actions).toHaveLength(Object.keys(inputs).length);
	expect(
		await client.call(conn, "results.summary", { campaign_id: id }),
	).toMatchObject({
		total: usd("80.00"),
		gift_count: 2,
		donor_count: 1,
	});
});
