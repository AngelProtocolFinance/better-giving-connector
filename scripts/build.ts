import { build } from "esbuild";

// UTC day of this build. The privacy and terms pages render it as the
// effective date; the source does not name a calendar day.
const buildDate = new Date().toISOString().slice(0, 10);

await build({
	entryPoints: ["src/index.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	packages: "external",
	outfile: "dist/index.js",
	define: {
		BUILD_DATE: JSON.stringify(buildDate),
	},
	loader: { ".mp4": "binary" },
});
