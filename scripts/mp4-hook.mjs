import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function load(url, context, nextLoad) {
	if (!url.endsWith(".mp4")) return nextLoad(url, context);
	const encoded = readFileSync(fileURLToPath(url)).toString("base64");
	return {
		format: "module",
		source: [
			`const bin = atob(${JSON.stringify(encoded)});`,
			"const out = new Uint8Array(bin.length);",
			"for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);",
			"export default out;",
		].join("\n"),
		shortCircuit: true,
	};
}
