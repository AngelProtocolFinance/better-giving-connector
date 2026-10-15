import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";

/** The demo import is the file bytes, matching esbuild's binary loader. */
function mp4Bytes(): Plugin {
	return {
		name: "mp4-bytes",
		enforce: "pre",
		load(id) {
			const path = id.split("?")[0] ?? id;
			if (!path.endsWith(".mp4")) return null;
			const encoded = readFileSync(path).toString("base64");
			return [
				`const bin = atob(${JSON.stringify(encoded)});`,
				"const out = new Uint8Array(bin.length);",
				"for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);",
				"export default out;",
			].join("\n");
		},
	};
}

export default defineConfig({
	plugins: [mp4Bytes()],
	test: {
		include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
	},
});
