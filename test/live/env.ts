import { readFileSync } from "node:fs";

/**
 * `LIVE_ORIGIN` and `LIVE_CODE` from the environment, with a git-ignored
 * `.env.live` filling anything the environment left unset. Throws before a
 * caller can open a connection when either is missing.
 */
export function readLiveEnv(
	env: NodeJS.ProcessEnv = process.env,
	file = ".env.live",
): { origin: string; code: string } {
	const fromFile = readEnvFile(file);
	const origin = env.LIVE_ORIGIN || fromFile.LIVE_ORIGIN || "";
	const code = env.LIVE_CODE || fromFile.LIVE_CODE || "";
	if (origin === "" || code === "") {
		throw new Error("set LIVE_ORIGIN and LIVE_CODE");
	}
	return { origin, code };
}

function readEnvFile(file: string): Record<string, string> {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return {};
		}
		throw error;
	}
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}
