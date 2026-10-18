import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FakeDeployment } from "../../../../test/fake-deployment";
import type { Call, Tokens } from "../../../../test/oauth";
import { connectFlow, shown } from "../../../../test/operator";

const ACTIVE = "/tmp/bgc-verify-active";
const REPLAY =
	"Already done: this matches an earlier call with the same details, so nothing new was recorded. The original result follows.";
const ORG = "Hope Shelter";

type Run = {
	runDir: string;
	evidence: string;
	publicUrl: string;
	fakeOrigin: string;
	caCert: string;
};

type Rpc = {
	result?: {
		content?: { type: string; text: string }[];
		isError?: boolean;
		instructions?: string;
		tools?: { name: string }[];
	};
	error?: { code?: number };
};

type DeploymentRow = { method: string; path: string; status: number };

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function redact(text: string): string {
	return text
		.replace(/bgk_[A-Za-z0-9_-]+/g, "[redacted]")
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(
			/"(access_token|refresh_token|id_token)"\s*:\s*"[^"]*"/g,
			'"$1":"[redacted]"',
		)
		.replace(/(__Secure-connect=)[^;\s]+/g, "$1[redacted]");
}

function loadRun(): Run {
	if (!existsSync(ACTIVE))
		fail("no active verification instance; run launch.sh");
	const envPath = readFileSync(ACTIVE, "utf8").trim();
	const values = new Map<string, string>();
	for (const line of readFileSync(envPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		values.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
	}
	const runDir = values.get("RUN_DIR");
	const evidence = values.get("EVIDENCE");
	const publicUrl = values.get("PUBLIC_URL");
	const fakeOrigin = values.get("FAKE_ORIGIN");
	const caCert = values.get("CA_CERT");
	if (!runDir || !evidence || !publicUrl || !fakeOrigin || !caCert) {
		fail(
			"active run file is missing RUN_DIR, EVIDENCE, PUBLIC_URL, FAKE_ORIGIN, or CA_CERT",
		);
	}
	if (process.env.NODE_EXTRA_CA_CERTS !== caCert) {
		fail(
			"NODE_EXTRA_CA_CERTS does not name this run's CA; run scripts/drive.sh so the fake certificate is trusted",
		);
	}
	return { runDir, evidence, publicUrl, fakeOrigin, caCert };
}

function featureDir(run: Run, feature: string): string {
	const dir = join(run.evidence, feature);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "transcript.txt"), "");
	return dir;
}

function line(dir: string, text: string): void {
	appendFileSync(join(dir, "transcript.txt"), `${redact(text)}\n`);
}

function save(dir: string, name: string, text: string): void {
	const safe = redact(text);
	if (safe.includes("bgk_")) fail(`${name} still contains a connection key`);
	writeFileSync(join(dir, name), safe.endsWith("\n") ? safe : `${safe}\n`);
}

function readLog(run: Run): DeploymentRow[] {
	const path = join(run.runDir, "deployment.ndjson");
	if (!existsSync(path)) return [];
	const rows: DeploymentRow[] = [];
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		if (raw === "") continue;
		rows.push(JSON.parse(raw) as DeploymentRow);
	}
	return rows;
}

function donationStatuses(rows: DeploymentRow[], from: number): number[] {
	const found: number[] = [];
	for (const row of rows.slice(from)) {
		if (row.method === "POST" && row.path === "/connector/v1/donations") {
			found.push(row.status);
		}
	}
	return found;
}

function sessionPath(run: Run): string {
	return join(run.runDir, "session.json");
}

function readToken(run: Run): string | null {
	const path = sessionPath(run);
	if (!existsSync(path)) return null;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as {
		accessToken?: string;
	};
	return parsed.accessToken ?? null;
}

function writeToken(run: Run, token: string): void {
	const path = sessionPath(run);
	writeFileSync(path, `${JSON.stringify({ accessToken: token })}\n`, {
		mode: 0o600,
	});
	chmodSync(path, 0o600);
}

async function rpc(res: Response): Promise<Rpc> {
	const text = await res.text();
	if (res.status !== 200) fail(`mcp http ${res.status}`);
	const body = res.headers.get("content-type")?.startsWith("text/event-stream")
		? text
				.split("\n")
				.filter((row) => row.startsWith("data:"))
				.map((row) => row.slice(5).trim())
				.join("")
		: text;
	const parsed = JSON.parse(body) as Rpc;
	if (parsed.error) fail(`mcp error ${parsed.error.code ?? "unknown"}`);
	return parsed;
}

function textOf(result: Rpc["result"]): string {
	return (result?.content ?? [])
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n");
}

async function mcp(
	run: Run,
	token: string,
	method: string,
	params?: Record<string, unknown>,
	id = 1,
): Promise<Rpc> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		authorization: `Bearer ${token}`,
	};
	if (method !== "initialize") headers["mcp-protocol-version"] = "2025-06-18";
	const res = await fetch(`${run.publicUrl}/mcp`, {
		method: "POST",
		redirect: "manual",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
	});
	return rpc(res);
}

// Undici sets `sec-fetch-mode: cors` and will not send `navigate`. better-auth
// answers that client with 200 JSON `{ redirect, url }` where a browser's
// `navigate` request receives 302. Follow `url`.
async function browserRedirect(res: Response): Promise<Response> {
	const type = res.headers.get("content-type") ?? "";
	if (res.status !== 200 || !type.includes("application/json")) return res;
	const text = await res.clone().text();
	let parsed: { redirect?: boolean; url?: string };
	try {
		parsed = JSON.parse(text) as { redirect?: boolean; url?: string };
	} catch {
		return res;
	}
	if (
		parsed.redirect !== true ||
		parsed.url === undefined ||
		parsed.url === ""
	) {
		return res;
	}
	return new Response(null, { status: 302, headers: { location: parsed.url } });
}

function connectorCall(dir: string, base: string): Call {
	return async (req) => {
		const fetched = await fetch(new Request(req, { redirect: "manual" }));
		const res = await browserRedirect(fetched);
		const url = new URL(req.url);
		line(dir, `${req.method} ${url.pathname} -> ${fetched.status}`);
		if (fetched.status !== res.status) {
			const location = res.headers.get("location");
			const target = location ? new URL(location, url) : null;
			line(dir, `json-redirect path=${target?.pathname ?? "none"}`);
		}
		if (
			req.method === "GET" &&
			url.pathname === "/connect" &&
			res.status === 200
		) {
			const html = shown(await res.clone().text());
			const titled = html.includes("<title>Connect Better Giving</title>");
			const button = html.includes(">Continue</button>");
			line(
				dir,
				`address page title=${titled ? "Connect Better Giving" : "missing"} button=${button ? "Continue" : "missing"}`,
			);
			if (!titled || !button)
				fail("address page is missing its title or Continue button");
		}
		if (
			req.method === "POST" &&
			url.pathname === "/connect" &&
			res.status === 302
		) {
			const location = res.headers.get("location");
			if (!location) fail("address submit returned no Location");
			const allow = new URL(location, url);
			line(dir, `allow host=${allow.host} path=${allow.pathname}`);
			if (
				allow.host !== "give.example.org" ||
				allow.pathname !== "/admin/connector/allow"
			) {
				fail(`Allow redirect was ${allow.host}${allow.pathname}`);
			}
		}
		if (url.pathname === "/connect/return") {
			const location = res.headers.get("location");
			const target = location ? new URL(location, url) : null;
			const hasCode = target?.searchParams.has("code") === true;
			line(
				dir,
				`return host=${target?.host ?? "none"} path=${target?.pathname ?? "none"} has-code=${hasCode ? "yes" : "no"}`,
			);
		}
		if (
			!url.href.startsWith(base) &&
			url.origin !== "https://give.example.org"
		) {
			line(dir, `request left the local connector for ${url.origin}`);
		}
		return res;
	};
}

function remoteFake(dir: string, origin: string): FakeDeployment {
	const host = new URL(origin).host;
	const fetchAllow: FakeDeployment["fetch"] = async (input, init) => {
		const req = new Request(input, init);
		const res = await fetch(new Request(req, { redirect: "manual" }));
		const url = new URL(req.url);
		line(dir, `${req.method} ${url.host}${url.pathname} -> ${res.status}`);
		return res;
	};
	return {
		host,
		origin: origin as FakeDeployment["origin"],
		fetch: fetchAllow,
		calls: [],
		issuedKeys: [],
		refuseKeys() {},
		setRelease() {},
		setActions() {},
		setExchangeName() {},
		mintCode() {
			return "";
		},
		intercept() {},
		handle: () => Promise.resolve(new Response(null, { status: 500 })),
	};
}

async function connect(run: Run, dir: string): Promise<string> {
	const flow = connectFlow(
		connectorCall(dir, run.publicUrl),
		remoteFake(dir, run.fakeOrigin),
		run.publicUrl,
	);
	const tokens: Tokens = await flow.connect("give.example.org");
	const opened = await mcp(run, tokens.access_token, "initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "chat-app", version: "1.0.0" },
	});
	const instructions = opened.result?.instructions ?? "";
	save(dir, "instructions.txt", instructions);
	const named = instructions.includes(ORG);
	line(dir, `initialize instructions-contain-${ORG}=${named ? "yes" : "no"}`);
	if (!named) fail(`initialize instructions do not name ${ORG}`);
	writeToken(run, tokens.access_token);
	line(dir, "connect ok");
	return tokens.access_token;
}

async function tokenFor(run: Run, dir: string): Promise<string> {
	return (await readToken(run)) ?? connect(run, dir);
}

async function tool(
	run: Run,
	token: string,
	name: string,
	args: Record<string, unknown>,
	id: number,
): Promise<string> {
	const result = await mcp(
		run,
		token,
		"tools/call",
		{ name, arguments: args },
		id,
	);
	return textOf(result.result);
}

function expectStatus(
	statuses: number[],
	expected: number,
	label: string,
): void {
	if (statuses.length !== 1 || statuses[0] !== expected) {
		fail(
			`${label} deployment statuses ${statuses.join(",") || "none"}, expected ${expected}`,
		);
	}
}

async function recordDonation(run: Run): Promise<void> {
	const dir = featureDir(run, "record-donation");
	const token = await tokenFor(run, dir);
	const stamp = new Date().toISOString();
	const day = stamp.slice(0, 10);
	const note = `verify-record-donation ${stamp}`;
	const gift = {
		amount: { amount: "25.00", currency: "USD" },
		date: day,
		donor: { name: "Verify Donor" },
		method: "cash",
		note,
	};
	const beforeFirst = readLog(run).length;
	const first = await tool(run, token, "record_donation", gift, 2);
	const firstStatus = donationStatuses(readLog(run), beforeFirst);
	expectStatus(firstStatus, 201, "record-first");
	const firstJson = JSON.parse(first) as {
		id?: string;
		note?: string;
		method?: string;
	};
	if (
		first.startsWith(REPLAY) ||
		firstJson.note !== note ||
		firstJson.method !== "cash" ||
		!firstJson.id
	) {
		fail("record-first was not a new cash gift");
	}
	save(dir, "record-first.txt", first);
	line(dir, `record-first deployment=201 id=${firstJson.id} note-matches=yes`);

	const beforeReplay = readLog(run).length;
	const replayed = await tool(run, token, "record_donation", gift, 3);
	const replayStatus = donationStatuses(readLog(run), beforeReplay);
	expectStatus(replayStatus, 200, "record-replay");
	if (!replayed.startsWith(`${REPLAY}\n`))
		fail("record-replay missing the already-done sentence");
	const replayJson = JSON.parse(replayed.slice(REPLAY.length + 1)) as {
		id?: string;
	};
	if (replayJson.id !== firstJson.id)
		fail("record-replay returned a different gift");
	save(dir, "record-replay.txt", replayed);
	line(dir, `record-replay deployment=200 same-id=yes`);

	const listed = await tool(run, token, "list_donations", {}, 4);
	save(dir, "list-after-replay.json", listed);
	const afterReplay = countNotes(listed, note);
	line(dir, `list-after-replay note-count=${afterReplay}`);
	if (afterReplay !== 1)
		fail(`list_donations showed ${afterReplay} gifts with the recorded note`);

	const secondNote = `${note} second`;
	const beforeSecond = readLog(run).length;
	const second = await tool(
		run,
		token,
		"record_donation",
		{ ...gift, note: secondNote },
		5,
	);
	const secondStatus = donationStatuses(readLog(run), beforeSecond);
	expectStatus(secondStatus, 201, "record-second");
	if (second.startsWith(REPLAY))
		fail("a distinguishing note was treated as a replay");
	const secondJson = JSON.parse(second) as { note?: string; id?: string };
	if (secondJson.note !== secondNote || secondJson.id === firstJson.id) {
		fail("distinguishing note did not record a new gift");
	}
	save(dir, "record-second.txt", second);
	line(dir, "record-second deployment=201 new-gift=yes");

	await clash(run, dir, token, stamp);
	line(dir, "record-donation ok");
	process.stdout.write(`record-donation ok evidence=${dir}\n`);
}

function countNotes(listed: string, note: string): number {
	const parsed = JSON.parse(listed) as { data?: { note?: string | null }[] };
	return (parsed.data ?? []).filter((gift) => gift.note === note).length;
}

async function clash(
	run: Run,
	dir: string,
	token: string,
	stamp: string,
): Promise<void> {
	const allow = await fetch(
		`${run.fakeOrigin}/admin/connector/allow?state=verify-clash`,
		{
			redirect: "manual",
		},
	);
	line(dir, `clash allow -> ${allow.status}`);
	const location = allow.headers.get("location");
	if (allow.status !== 302 || !location) fail(`clash allow -> ${allow.status}`);
	const code = new URL(location).searchParams.get("code");
	if (!code) fail("clash allow returned no code");
	const exchanged = await fetch(`${run.fakeOrigin}/connector/v1/exchange`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ code }),
	});
	line(dir, `clash exchange -> ${exchanged.status}`);
	if (exchanged.status !== 200) fail(`clash exchange -> ${exchanged.status}`);
	const payload = (await exchanged.json()) as { key?: string };
	const key = payload.key;
	if (!key) fail("clash exchange returned no key");

	const note = `verify-clash ${stamp}`;
	const gift = {
		amount: { amount: "10.00", currency: "USD" },
		date: stamp.slice(0, 10),
		donor: { name: "Verify Clash" },
		method: "cash",
		note,
	};
	const raw = JSON.stringify(gift);
	const different = JSON.stringify({ ...gift, note: `${note} different` });
	const post = (body: string) => {
		const before = readLog(run).length;
		return fetch(`${run.fakeOrigin}/connector/v1/donations`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
				accept: "application/json",
				"idempotency-key": `verify-clash-${stamp}`,
			},
			body,
		}).then(async (res) => {
			const text = await res.text();
			const statuses = donationStatuses(readLog(run), before);
			return { status: res.status, text, logged: statuses[0] };
		});
	};
	const created = await post(raw);
	const replayed = await post(raw);
	const conflict = await post(different);
	line(
		dir,
		`clash http=${created.status},${replayed.status},${conflict.status} logged=${created.logged},${replayed.logged},${conflict.logged}`,
	);
	if (
		created.status !== 201 ||
		replayed.status !== 200 ||
		conflict.status !== 409
	) {
		fail("Idempotency-Key replay was not 201, 200, then 409");
	}
	if (
		created.logged !== 201 ||
		replayed.logged !== 200 ||
		conflict.logged !== 409
	) {
		fail("donation-site log did not show 201, 200, then 409");
	}
	const createdJson = JSON.parse(created.text) as { id?: string };
	const replayJson = JSON.parse(replayed.text) as { id?: string };
	if (!createdJson.id || createdJson.id !== replayJson.id)
		fail("clash replay body was not the original gift");
	const problem = JSON.parse(conflict.text) as { code?: string };
	if (problem.code !== "idempotency_conflict")
		fail("409 body was not idempotency_conflict");
	save(dir, "clash-201.json", created.text);
	save(dir, "clash-200.json", replayed.text);
	save(dir, "clash-409.json", conflict.text);

	const listed = await tool(run, token, "list_donations", {}, 6);
	save(dir, "list-after-clash.json", listed);
	const count = countNotes(listed, note);
	line(dir, `list-after-clash clash-note-count=${count}`);
	if (count !== 1) fail("the 409 clash still added a gift");
}

async function createCampaign(run: Run): Promise<void> {
	const dir = featureDir(run, "create-campaign");
	const token = await tokenFor(run, dir);
	const title = `Verify draft ${new Date().toISOString()}`;
	const before = readLog(run).length;
	const first = await tool(run, token, "create_campaign", { title }, 2);
	const firstRows = readLog(run).slice(before);
	const created = firstRows.filter(
		(row) => row.method === "POST" && row.path === "/connector/v1/campaigns",
	);
	if (created.length !== 1 || created[0]?.status !== 201)
		fail("create_campaign did not reach the donation site as 201");
	line(dir, "create-first deployment=201");
	const firstJson = JSON.parse(first) as {
		id?: string;
		title?: string;
		status?: string;
	};
	if (
		first.startsWith(REPLAY) ||
		firstJson.title !== title ||
		firstJson.status !== "draft" ||
		!firstJson.id
	) {
		fail("create_campaign did not return a new draft");
	}
	save(dir, "create-first.txt", first);
	const replayed = await tool(run, token, "create_campaign", { title }, 3);
	if (!replayed.startsWith(`${REPLAY}\n`))
		fail("create_campaign replay missing the already-done sentence");
	const replayJson = JSON.parse(replayed.slice(REPLAY.length + 1)) as {
		id?: string;
	};
	if (replayJson.id !== firstJson.id)
		fail("create_campaign replay returned a different campaign");
	save(dir, "create-replay.txt", replayed);
	const listed = await tool(run, token, "list_campaigns", {}, 4);
	save(dir, "list-campaigns.json", listed);
	const titles =
		(JSON.parse(listed) as { data?: { title?: string }[] }).data ?? [];
	const matches = titles.filter((row) => row.title === title).length;
	line(
		dir,
		`create-campaign draft=yes replay-same-id=yes list-count=${matches}`,
	);
	if (matches !== 1)
		fail(`list_campaigns showed ${matches} campaigns with the new title`);
	line(dir, "create-campaign ok");
	process.stdout.write(`create-campaign ok evidence=${dir}\n`);
}

const READS = [
	"list_campaigns",
	"get_donation_page",
	"get_block_catalog",
	"list_forms",
	"get_results",
	"list_donations",
	"list_donors",
	"list_recurring_gifts",
] as const;

async function readTools(run: Run): Promise<void> {
	const dir = featureDir(run, "read-tools");
	const token = await tokenFor(run, dir);
	const listed = await mcp(run, token, "tools/list", {}, 2);
	const names = (listed.result?.tools ?? []).map((item) => item.name);
	save(dir, "tools.txt", names.join("\n"));
	for (const name of READS) {
		if (!names.includes(name)) fail(`tools/list is missing ${name}`);
	}
	let id = 3;
	for (const name of READS) {
		const body = await tool(run, token, name, {}, id);
		id += 1;
		JSON.parse(body);
		save(dir, `${name}.json`, body);
		line(dir, `${name} json=yes`);
	}
	const forms = JSON.parse(
		readFileSync(join(dir, "list_forms.json"), "utf8"),
	) as {
		data?: { id?: string }[];
	};
	const formId = forms.data?.[0]?.id;
	if (!formId) fail("list_forms returned no form; the fake seeds frm_1");
	const form = await tool(run, token, "get_form", { id: formId }, id);
	id += 1;
	save(dir, "get_form.json", form);
	line(dir, `get_form id=${formId}`);

	const campaigns = JSON.parse(
		readFileSync(join(dir, "list_campaigns.json"), "utf8"),
	) as {
		data?: { id?: string }[];
	};
	const campaignId = campaigns.data?.[0]?.id;
	if (!campaignId) {
		line(dir, "get_campaign unreachable: list_campaigns returned no id");
	} else {
		const campaign = await tool(
			run,
			token,
			"get_campaign",
			{ id: campaignId },
			id,
		);
		id += 1;
		save(dir, "get_campaign.json", campaign);
		line(dir, `get_campaign id=${campaignId}`);
	}
	const donors = JSON.parse(
		readFileSync(join(dir, "list_donors.json"), "utf8"),
	) as {
		data?: { id?: string }[];
	};
	const donorId = donors.data?.[0]?.id;
	if (!donorId) {
		line(dir, "get_donor unreachable: list_donors returned no id");
	} else {
		const donor = await tool(run, token, "get_donor", { id: donorId }, id);
		save(dir, "get_donor.json", donor);
		line(dir, `get_donor id=${donorId}`);
	}
	line(dir, "read-tools ok");
	process.stdout.write(`read-tools ok evidence=${dir}\n`);
}

const PAGES: { path: string; title: string; sentence: string }[] = [
	{
		path: "/docs",
		title: "Documentation — Better Giving Connector",
		sentence: "The Better Giving Connector lets a nonprofit",
	},
	{
		path: "/support",
		title: "Support — Better Giving Connector",
		sentence: "support@better.giving",
	},
	{
		path: "/privacy",
		title: "Privacy Policy — Better Giving Connector",
		sentence: "Privacy Policy",
	},
	{
		path: "/terms",
		title: "Terms of Service — Better Giving Connector",
		sentence: "These Terms govern your use of the Better Giving Connector",
	},
];

async function publicPages(run: Run): Promise<void> {
	const dir = featureDir(run, "public-pages");
	for (const page of PAGES) {
		const res = await fetch(`${run.publicUrl}${page.path}`, {
			redirect: "manual",
		});
		const html = await res.text();
		const title = html.includes(`<title>${page.title}</title>`);
		const sentence = html.includes(page.sentence);
		line(
			dir,
			`GET ${page.path} -> ${res.status} title=${title ? "yes" : "no"} sentence=${sentence ? "yes" : "no"}`,
		);
		if (res.status !== 200 || !title || !sentence)
			fail(`${page.path} did not render its page`);
		save(dir, `${page.path.slice(1)}.html`, html);
	}
	const root = await fetch(`${run.publicUrl}/`, { redirect: "manual" });
	const rootLocation = root.headers.get("location");
	line(dir, `GET / -> ${root.status} location=${rootLocation ?? ""}`);
	if (root.status !== 302 || rootLocation !== "/docs")
		fail(
			`GET / returned ${root.status} ${rootLocation ?? ""}; /docs is the directory`,
		);
	line(dir, "public-pages ok");
	process.stdout.write(`public-pages ok evidence=${dir}\n`);
}

async function main(): Promise<void> {
	const command = process.argv[2];
	const run = loadRun();
	if (command === "connect") {
		const dir = featureDir(run, "connect");
		await connect(run, dir);
		process.stdout.write(`connect ok evidence=${dir}\n`);
		return;
	}
	if (command === "record-donation") return recordDonation(run);
	if (command === "create-campaign") return createCampaign(run);
	if (command === "read-tools") return readTools(run);
	if (command === "public-pages") return publicPages(run);
	fail(
		"usage: drive.sh connect | record-donation | create-campaign | read-tools | public-pages",
	);
}

try {
	await main();
} catch (error) {
	const message = error instanceof Error ? error.message : "drive failed";
	process.stderr.write(`${redact(message)}\n`);
	process.exit(1);
}
