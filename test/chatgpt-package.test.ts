import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	buildChatgptPackage,
	mcpManifest,
	PENDING_JUSTIN_OK,
	packageEntries,
	pluginManifest,
	zipEntries,
	zipStore,
} from "../scripts/chatgpt-package";

/** WCAG relative-luminance contrast of a #RRGGBB color against white. */
function contrastAgainstWhite(hex: string): number {
	const channels = [0, 2, 4].map((at) => {
		const channel = Number.parseInt(hex.slice(at + 1, at + 3), 16) / 255;
		return channel <= 0.04045
			? channel / 12.92
			: ((channel + 0.055) / 1.055) ** 2.4;
	});
	const red = channels[0] ?? 0;
	const green = channels[1] ?? 0;
	const blue = channels[2] ?? 0;
	const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
	return 1.05 / (luminance + 0.05);
}

const manifest = pluginManifest();
const iface = manifest.extensions["com.openai"].interface;
const review = manifest.extensions["com.openai"].review;

test("plugin.json matches the packet's listing and records the pending recommendations", () => {
	expect(manifest.name).toBe("better-giving");
	expect(manifest.version).toBe("1.0.0");
	expect(iface.displayName.length).toBeLessThanOrEqual(30);
	expect(iface.shortDescription.length).toBeLessThanOrEqual(30);
	expect(iface.longDescription.length).toBeLessThanOrEqual(4000);
	expect(iface.longDescription).toMatch(/moves no money/i);
	expect(iface.longDescription).toMatch(/cash or by check/i);
	expect(iface.longDescription).toMatch(/record nothing new/i);
	expect(iface.longDescription).toContain("better.giving");
	expect(iface.longDescription).toContain(
		"your own Better Giving site's address",
	);
	expect(`${manifest.description} ${iface.longDescription}`).not.toMatch(
		/self-hosted|ChatGPT|Claude|bank transfer/i,
	);
	expect(iface.defaultPrompt).toHaveLength(3);
	for (const prompt of iface.defaultPrompt) {
		expect(prompt.length).toBeLessThanOrEqual(128);
	}
	expect(iface.privacyPolicyURL).toBe(
		"https://app.connect.better.giving/privacy",
	);
	expect(iface.termsOfServiceURL).toBe(
		"https://app.connect.better.giving/terms",
	);
	expect(iface.supportURL).toBe("https://app.connect.better.giving/support");
	expect(iface.logo).toBe("./assets/logo.png");
	expect(iface.composerIcon).toBe("./assets/icon.png");
	expect(review.commerce).toBe(false);
	expect(review.test_cases.positive).toHaveLength(5);
	expect(review.test_cases.negative).toHaveLength(3);
	expect(review.commerce_description).toMatch(/record_donation/);
	expect(manifest.license).toBe("MIT");
	expect(manifest.homepage).toBe("https://better.giving");
	expect(iface.websiteURL).toBe("https://better.giving");
	expect(manifest.author).toMatchObject({
		name: "Better Giving",
		email: "support@better.giving",
		url: "https://better.giving",
	});
	expect(iface.brandColor).toBe("#1E6DAB");
	expect(contrastAgainstWhite(iface.brandColor)).toBeGreaterThanOrEqual(2);
	expect(iface.category).toBe("Business & Operations");
	expect(review.demo_recording_url).toBe(
		"https://app.connect.better.giving/demo.mp4",
	);
	expect(manifest.extensions["com.openai"].publication.countries).toEqual([]);
	expect(PENDING_JUSTIN_OK).toEqual({
		category: "Business & Operations",
		countries: [],
	});
	expect(iface.category).toBe(PENDING_JUSTIN_OK.category);
	expect(manifest.extensions["com.openai"].publication.countries).toEqual([
		...PENDING_JUSTIN_OK.countries,
	]);
});

test("mcp.json points at the production server and declares DCR with no secret", () => {
	const mcp = mcpManifest();
	const server = mcp.mcpServers["better-giving"];

	expect(server).toMatchObject({
		type: "streamable-http",
		url: "https://app.connect.better.giving/mcp",
	});
	expect(server.extensions["com.openai"].auth).toEqual({
		type: "oauth",
		client: { mode: "dcr" },
	});
	expect(JSON.stringify(mcp)).not.toMatch(/secret/i);
});

test("the zip contains the manifest, the mcp config, and square icons", () => {
	const archive = zipStore(packageEntries());
	const entries = zipEntries(archive);

	expect([...entries.keys()]).toEqual([
		"plugin.json",
		"mcp.json",
		"assets/icon.png",
		"assets/logo.png",
		"assets/icon.svg",
	]);
	const png = entries.get("assets/logo.png") ?? Buffer.alloc(0);
	expect(png.readUInt32BE(16)).toBe(512);
	expect(png.readUInt32BE(20)).toBe(512);
	expect(entries.get("assets/icon.png")?.equals(png)).toBe(true);
	expect(entries.get("assets/icon.svg")?.toString()).toContain(
		'viewBox="0 0 512 512"',
	);
	const packed = JSON.parse(
		(entries.get("plugin.json") ?? Buffer.alloc(0)).toString(),
	);
	expect(packed.name).toBe("better-giving");
	expect(archive.includes(Buffer.from("://connect.better.giving"))).toBe(false);
});

test("buildChatgptPackage writes that zip", () => {
	const dir = mkdtempSync(join(tmpdir(), "chatgpt-package-"));
	const out = join(dir, "better-giving-chatgpt.zip");
	try {
		buildChatgptPackage(out);
		const entries = zipEntries(readFileSync(out));
		expect(entries.has("plugin.json")).toBe(true);
		expect(entries.has("mcp.json")).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
