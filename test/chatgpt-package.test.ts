import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { expect, test } from "vitest";
import {
	chatGptPackageEntries,
	chatGptPackageZip,
} from "../src/site/chatgpt-package";
import { ICON_PNG } from "../src/site/icon";
import type { ZipEntry } from "../src/site/zip";

function unzip(buf: Buffer): Map<string, Buffer> {
	const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	expect(eocd).toBeGreaterThanOrEqual(0);
	const count = buf.readUInt16LE(eocd + 8);
	const centralSize = buf.readUInt32LE(eocd + 12);
	const centralAt = buf.readUInt32LE(eocd + 16);
	expect(centralAt + centralSize).toBe(eocd);
	const files = new Map<string, Buffer>();
	let at = centralAt;
	for (let i = 0; i < count; i++) {
		expect(buf.readUInt32LE(at)).toBe(0x02014b50);
		const method = buf.readUInt16LE(at + 10);
		const crc = buf.readUInt32LE(at + 16);
		const size = buf.readUInt32LE(at + 20);
		const nameLen = buf.readUInt16LE(at + 28);
		const extra = buf.readUInt16LE(at + 30);
		const comment = buf.readUInt16LE(at + 32);
		const localAt = buf.readUInt32LE(at + 42);
		const name = buf.subarray(at + 46, at + 46 + nameLen).toString();
		expect(method).toBe(0);
		expect(buf.readUInt32LE(localAt)).toBe(0x04034b50);
		const localName = buf.readUInt16LE(localAt + 26);
		const localExtra = buf.readUInt16LE(localAt + 28);
		const data = buf.subarray(
			localAt + 30 + localName + localExtra,
			localAt + 30 + localName + localExtra + size,
		);
		expect(crc32(data) >>> 0).toBe(crc);
		files.set(name, Buffer.from(data));
		at += 46 + nameLen + extra + comment;
	}
	expect(at).toBe(eocd);
	return files;
}

test("the package zip holds the manifest, MCP config, and both icons", () => {
	const files = unzip(chatGptPackageZip());

	expect([...files.keys()].toSorted()).toEqual([
		"assets/icon.png",
		"assets/logo.png",
		"mcp.json",
		"plugin.json",
	]);
	expect(files.get("assets/icon.png")).toEqual(Buffer.from(ICON_PNG));
	expect(files.get("assets/logo.png")).toEqual(Buffer.from(ICON_PNG));
	const png = files.get("assets/logo.png") ?? Buffer.alloc(0);
	expect(png.subarray(12, 16).toString()).toBe("IHDR");
	expect(png.readUInt32BE(16)).toBe(512);
	expect(png.readUInt32BE(20)).toBe(512);
});

test("plugin.json fills the known listing and omits undecided fields", () => {
	const entries: ZipEntry[] = chatGptPackageEntries();
	const plugin = JSON.parse(
		Buffer.from(entries[0]?.data ?? new Uint8Array()).toString(),
	) as {
		name: string;
		license?: string;
		author: { name: string; email?: string; url: string };
		extensions: {
			"com.openai": {
				interface: {
					displayName: string;
					shortDescription: string;
					longDescription: string;
					category?: string;
					brandColor?: string;
					privacyPolicyURL: string;
					termsOfServiceURL: string;
					supportURL: string;
					websiteURL: string;
					defaultPrompt: string[];
					logo: string;
					composerIcon: string;
				};
				review: {
					test_cases: { positive: unknown[]; negative: unknown[] };
					demo_recording_url?: string;
					commerce: boolean;
				};
				publication: { release_notes: string; countries?: string[] };
			};
		};
	};
	const face = plugin.extensions["com.openai"].interface;

	expect(plugin.name).toBe("better-giving");
	expect(plugin.license).toBeUndefined();
	expect(plugin.author.email).toBeUndefined();
	expect(plugin.author.name).toBe("Better Giving");
	expect(face.displayName.length).toBeLessThanOrEqual(30);
	expect(face.shortDescription.length).toBeLessThanOrEqual(30);
	expect(face.longDescription.length).toBeLessThanOrEqual(4000);
	expect(face.longDescription).toContain("record_donation");
	expect(face.longDescription).toMatch(/does not process payments/);
	expect(face.category).toBeUndefined();
	expect(face.brandColor).toBeUndefined();
	expect(face.privacyPolicyURL).toBe(
		"https://app.connect.better.giving/privacy",
	);
	expect(face.termsOfServiceURL).toBe(
		"https://app.connect.better.giving/terms",
	);
	expect(face.supportURL).toBe("https://app.connect.better.giving/support");
	expect(face.websiteURL).toBe("https://better.giving");
	expect(face.defaultPrompt).toHaveLength(3);
	expect(face.logo).toBe("./assets/logo.png");
	expect(face.composerIcon).toBe("./assets/icon.png");
	expect(
		plugin.extensions["com.openai"].review.test_cases.positive,
	).toHaveLength(5);
	expect(
		plugin.extensions["com.openai"].review.test_cases.negative,
	).toHaveLength(3);
	expect(plugin.extensions["com.openai"].review.commerce).toBe(false);
	expect(
		plugin.extensions["com.openai"].review.demo_recording_url,
	).toBeUndefined();
	expect(plugin.extensions["com.openai"].publication.countries).toBeUndefined();
	expect(plugin.extensions["com.openai"].publication.release_notes).toBe(
		"Initial release.",
	);
	expect(JSON.stringify(plugin)).not.toContain("TODO");
	expect(JSON.stringify(plugin)).not.toMatch(/\[[A-Z]/);
});

test("mcp.json points at the production MCP server with DCR and no secret", () => {
	const entries = chatGptPackageEntries();
	const mcp = JSON.parse(
		Buffer.from(entries[1]?.data ?? new Uint8Array()).toString(),
	) as {
		mcpServers: {
			"better-giving": {
				type: string;
				url: string;
				extensions: {
					"com.openai": {
						auth: {
							type: string;
							client: { mode: string; clientId?: string };
							baseScopes: string[];
						};
					};
				};
			};
		};
	};
	const server = mcp.mcpServers["better-giving"];

	expect(server.type).toBe("streamable-http");
	expect(server.url).toBe("https://app.connect.better.giving/mcp");
	expect(server.extensions["com.openai"].auth).toEqual({
		type: "oauth",
		client: { mode: "dcr" },
		baseScopes: ["offline_access"],
	});
	expect(JSON.stringify(mcp)).not.toMatch(/secret/i);
	expect(JSON.stringify(mcp)).not.toContain("https://connect.better.giving");
});

test("the package script writes a zip unzip can read", () => {
	execFileSync("pnpm", ["chatgpt:package"], { stdio: "pipe" });
	const zip = readFileSync("dist/better-giving-chatgpt.zip");
	expect(unzip(zip).has("plugin.json")).toBe(true);
});
