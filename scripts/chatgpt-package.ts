import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { ICON_SVG, iconPng } from "../src/site/icon";

// ChatGPT app package from the directory packet (plugin.json + mcp.json + assets/).
// PLACEHOLDER until Justin decides: category, demo_recording_url, and
// publication.countries. Those three stay out of the package.
// homepage and websiteURL are https://better.giving, which resolves to the
// public site. author.email is the support address already on /support and /terms.
// brandColor is the brand blue from AngelProtocolFinance/better-giving
// packages/brand (design-system.md and colors.ts `primary`): #1E6DAB, the
// Radix accent `accent-light=1E6DAB`, `--blue-9` / `--primary`.
// Review cases are the packet's drafts. Auth is OAuth dynamic client registration.
// The Agent Plugins mcp schema does not list `extensions`, and OpenAI's
// submission guide puts DCR on the server anyway.

const ORIGIN = "https://app.connect.better.giving";

/**
 * Better Giving brand blue. `#1E6DAB` is `--primary` / `--blue-9` in
 * AngelProtocolFinance/better-giving `packages/brand/src/colors.ts`, the hex
 * twin of the light palette. `packages/brand/design-system.md` names it the
 * brand blue and the unmodified step-9 input
 * `accent-light=1E6DAB` on the Radix custom palette.
 * Contrast against white is about 5.48:1, above the directory's 2:1 floor.
 */
export const BRAND_COLOR = "#1E6DAB";

/** Support address already published on /support, /privacy, and /terms. */
export const AUTHOR_EMAIL = "support@better.giving";

/** Directory fields left out of the package until Justin answers. */
export const UNDECIDED = [
	"extensions.com.openai.interface.category",
	"extensions.com.openai.review.demo_recording_url",
	"extensions.com.openai.publication.countries",
] as const;

const LONG_DESCRIPTION = [
	"Connect ChatGPT to a self-hosted Better Giving donation site.",
	"List and edit campaigns, build donation forms, update the donation page, look up donations, donors and monthly gifts, and see fundraising results.",
	"record_donation records a gift that was already received offline (cash, check, or bank transfer).",
	"It moves no money, charges no card, and cannot refund or pay out.",
	"The connector acts only on the one site you connect.",
	"It needs a Better Giving standalone site that speaks connector contract v1, and a dashboard account on that site.",
].join(" ");

export function pluginManifest() {
	return {
		$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
		name: "better-giving",
		version: "1.0.0",
		description:
			"Manage a self-hosted Better Giving donation site: campaigns, forms, the donation page, donations and donors. Records offline gifts and moves no money.",
		author: {
			name: "Better Giving",
			email: AUTHOR_EMAIL,
			url: "https://better.giving",
		},
		homepage: "https://better.giving",
		license: "MIT",
		repository:
			"https://github.com/AngelProtocolFinance/better-giving-connector",
		keywords: ["nonprofit", "donations", "fundraising"],
		extensions: {
			"com.openai": {
				interface: {
					displayName: "Better Giving",
					shortDescription: "Run your donation site",
					longDescription: LONG_DESCRIPTION,
					developerName: "Better Giving",
					capabilities: [
						"Manage campaigns",
						"Manage donation forms",
						"Review donations and donors",
						"Record offline donations",
					],
					websiteURL: "https://better.giving",
					brandColor: BRAND_COLOR,
					// PLACEHOLDER: category. Left out until Justin decides.
					supportURL: `${ORIGIN}/support`,
					privacyPolicyURL: `${ORIGIN}/privacy`,
					termsOfServiceURL: `${ORIGIN}/terms`,
					defaultPrompt: [
						"List my published campaigns.",
						"How much did we raise this month?",
						"Create a draft campaign for our winter appeal.",
					],
					composerIcon: "./assets/icon.png",
					logo: "./assets/logo.png",
				},
				review: {
					// PLACEHOLDER: demo_recording_url. Left out until Justin decides.
					test_cases: {
						positive: [
							{
								description: "List campaigns",
								prompt: "List my campaigns",
								tools_triggered: "list_campaigns",
								expected_behavior:
									"Returns the connected site's campaigns, each with a status and a public link.",
							},
							{
								description: "Campaign total raised",
								prompt: "How much has the Winter Appeal raised?",
								tools_triggered: "list_campaigns, get_results",
								expected_behavior:
									"Finds the Winter Appeal campaign and returns its fundraising totals.",
							},
							{
								description: "Recent donations",
								prompt: "Show the last 10 donations",
								tools_triggered: "list_donations",
								expected_behavior:
									"Returns a list of recent gifts from the connected site.",
							},
							{
								description: "Create a draft campaign",
								prompt: "Create a draft campaign called Spring Drive",
								tools_triggered: "create_campaign",
								expected_behavior:
									"Creates a draft campaign named Spring Drive. Donors cannot see a draft until it is published.",
							},
							{
								description: "Record an offline cash gift",
								prompt: "Record a $50 cash donation from Jane Doe today",
								tools_triggered: "record_donation",
								expected_behavior:
									"Records an offline $50 cash gift from Jane Doe. Moves no money and charges nothing.",
							},
						],
						negative: [
							{
								description: "No refunds",
								prompt: "Refund Jane's donation",
								expected_behavior:
									"Does not refund or move money. Explains that the connector cannot move money.",
							},
							{
								description: "Publish waits for confirmation",
								prompt: "Publish the Spring Drive campaign",
								expected_behavior:
									"Does not publish until the operator confirms. Says what will change and asks first.",
							},
							{
								description: "Only the connected site",
								prompt: "Show donations for a different nonprofit",
								expected_behavior:
									"Does not read another organization's data. Acts only on the connected site.",
							},
						],
					},
					commerce: false,
					commerce_description:
						"Does not sell goods or process payments; record_donation logs an offline gift.",
				},
				publication: {
					// PLACEHOLDER: countries. Left out until Justin decides.
					release_notes: "Initial release.",
				},
			},
		},
	};
}

export function mcpManifest() {
	return {
		$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
		mcpServers: {
			"better-giving": {
				type: "streamable-http",
				url: `${ORIGIN}/mcp`,
				extensions: {
					"com.openai": {
						auth: {
							type: "oauth",
							client: { mode: "dcr" },
						},
					},
				},
			},
		},
	};
}

const json = (value: unknown) =>
	Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export function packageEntries(): { name: string; data: Buffer }[] {
	const png = Buffer.from(iconPng());
	return [
		{ name: "plugin.json", data: json(pluginManifest()) },
		{ name: "mcp.json", data: json(mcpManifest()) },
		{ name: "assets/icon.png", data: png },
		{ name: "assets/logo.png", data: png },
		{ name: "assets/icon.svg", data: Buffer.from(ICON_SVG) },
	];
}

// Fixed so two builds of the same bytes are the same zip. 2026-10-15.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 15;

export function zipStore(entries: { name: string; data: Buffer }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const crc = crc32(entry.data);
		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(entry.data.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		name.copy(local, 30);
		locals.push(local, entry.data);

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(DOS_TIME, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(entry.data.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);
		centrals.push(central);
		offset += local.length + entry.data.length;
	}
	const centralDir = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralDir.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);
	return Buffer.concat([...locals, centralDir, eocd]);
}

export function zipEntries(archive: Buffer): Map<string, Buffer> {
	const eocd = archive.length - 22;
	if (archive.readUInt32LE(eocd) !== 0x06054b50) {
		throw new Error("zip is missing its end record");
	}
	const count = archive.readUInt16LE(eocd + 8);
	let cursor = archive.readUInt32LE(eocd + 16);
	const out = new Map<string, Buffer>();
	for (let i = 0; i < count; i++) {
		if (archive.readUInt32LE(cursor) !== 0x02014b50) {
			throw new Error("zip central directory is truncated");
		}
		const size = archive.readUInt32LE(cursor + 20);
		const nameLen = archive.readUInt16LE(cursor + 28);
		const extraLen = archive.readUInt16LE(cursor + 30);
		const commentLen = archive.readUInt16LE(cursor + 32);
		const localAt = archive.readUInt32LE(cursor + 42);
		const name = archive
			.subarray(cursor + 46, cursor + 46 + nameLen)
			.toString();
		const localNameLen = archive.readUInt16LE(localAt + 26);
		const localExtraLen = archive.readUInt16LE(localAt + 28);
		const dataAt = localAt + 30 + localNameLen + localExtraLen;
		out.set(name, archive.subarray(dataAt, dataAt + size));
		cursor += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

export function buildChatgptPackage(outPath: string): void {
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, zipStore(packageEntries()));
}

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc ^= data[i] ?? 0;
		for (let bit = 0; bit < 8; bit++) {
			const mask = -(crc & 1);
			crc = (crc >>> 1) ^ (0xedb88320 & mask);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	const out = process.argv[2] ?? "dist/better-giving-chatgpt.zip";
	buildChatgptPackage(out);
	process.stdout.write(`${out}\n`);
}
