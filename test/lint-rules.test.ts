import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Each fixture is a file at the path the rule scopes on; `fires` lists the
// rules expected on it, none for a file that must stay clean.
type Rule = "restricted-import" | "console" | "coerce-boolean" | "stage";
const fixtures: Record<string, { source: string; fires: Rule[] }> = {
	"src/coerce-z.ts": {
		source: "z.coerce.boolean();\n",
		fires: ["coerce-boolean"],
	},
	"src/coerce-alias.ts": {
		source: "zod.coerce.boolean();\nv.coerce.boolean();\n",
		fires: ["coerce-boolean"],
	},
	"src/coerce-bracket.ts": {
		source: 'z["coerce"].boolean();\nz.coerce["boolean"]();\n',
		fires: ["coerce-boolean"],
	},
	"src/coerce-destructured.ts": {
		source: "const { coerce } = z;\ncoerce.boolean();\n",
		fires: ["coerce-boolean"],
	},
	"test/coerce-in-tests.ts": {
		source: "z.coerce.boolean();\n",
		fires: ["coerce-boolean"],
	},
	"src/coerce-clean.ts": {
		source: "z.coerce.number();\nz.boolean();\nz.stringbool();\n",
		fires: [],
	},
	"src/stage-process.ts": {
		source: 'export const a = process.env.NODE_ENV === "production";\n',
		fires: ["stage"],
	},
	"src/stage-parsed-env.ts": {
		source:
			'export const a = env.NODE_ENV === "test";\nexport const b = "preview" == env.VERCEL_ENV;\n',
		fires: ["stage"],
	},
	"src/stage-bracket.ts": {
		source: 'export const a = process.env["NODE_ENV"] !== "test";\n',
		fires: ["stage"],
	},
	"src/stage-clean.ts": {
		source:
			'export const a = env.PUBLIC_URL === "production";\nexport const b = env.NODE_ENV;\n',
		fires: [],
	},
	"src/stage-in.test.ts": {
		source: 'export const a = process.env.NODE_ENV === "test";\n',
		fires: [],
	},
	"src/api/deep-vendor.ts": {
		source: [
			'import "@modelcontextprotocol/server/stdio";',
			'import "better-auth/adapters/kysely";',
			'import "@better-auth/oauth-provider/client";',
			'import "@libsql/client/web";',
			"",
		].join("\n"),
		fires: ["restricted-import"],
	},
	"src/mcp/inside.ts": {
		source: 'import "@modelcontextprotocol/server/stdio";\n',
		fires: [],
	},
	"src/auth/inside.ts": {
		source: 'import "better-auth/plugins/oauth";\n',
		fires: [],
	},
	"src/auth/outside.ts": {
		source:
			'import "@libsql/client/web";\nimport "@modelcontextprotocol/server/stdio";\n',
		fires: ["restricted-import"],
	},
	"src/db/inside.ts": {
		source: 'import "@libsql/client/web";\n',
		fires: [],
	},
	"src/db/outside.ts": {
		source: 'import "better-auth/adapters/kysely";\n',
		fires: ["restricted-import"],
	},
	"src/mcp/outside.ts": {
		source: 'import "better-auth/plugins/oauth";\n',
		fires: ["restricted-import"],
	},
	"src/deployment/reaches-in.ts": {
		source:
			'import "../db/connections";\nimport "../auth";\nimport "../mcp/run-tool";\n',
		fires: ["restricted-import"],
	},
	"src/deployment/vendor.ts": {
		source: 'import "better-auth/plugins/oauth";\n',
		fires: ["restricted-import"],
	},
	"src/deployment/clean.ts": {
		source: 'import "./origin";\nimport "../secret";\n',
		fires: [],
	},
	"src/deployment/reaches-in.test.ts": {
		source: 'import "../db/connections";\n',
		fires: [],
	},
	"src/console-use.ts": {
		source: 'console.log("x");\n',
		fires: ["console"],
	},
	"src/log.ts": {
		source: 'console.log("x");\n',
		fires: [],
	},
};

const RULE_OF: Record<string, Rule> = {
	"lint/style/noRestrictedImports": "restricted-import",
	"lint/suspicious/noConsole": "console",
};
const PLUGIN_RULE: [RegExp, Rule][] = [
	[/coerce\.boolean/, "coerce-boolean"],
	[/branch on the stage/, "stage"],
];

const root = join(__dirname, "..");
let dir: string;
let firedBy: Record<string, Set<Rule>>;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "lint-rules-"));
	// the repo's own biome.json, minus the git-ignore lookup (the temp dir has no repo)
	const config = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
	config.vcs.enabled = false;
	writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
	cpSync(join(root, "lint"), join(dir, "lint"), { recursive: true });
	for (const [path, { source }] of Object.entries(fixtures)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), source);
	}

	const run = spawnSync(
		join(root, "node_modules/.bin/biome"),
		["lint", "--reporter=json", "--max-diagnostics=none", "."],
		{ cwd: dir, encoding: "utf8" },
	);
	const report = JSON.parse(run.stdout);
	firedBy = {};
	for (const d of report.diagnostics) {
		const file: string = d.location?.path;
		const rule =
			RULE_OF[d.category] ??
			PLUGIN_RULE.find(([re]) => re.test(d.message))?.[1];
		if (!rule) continue;
		firedBy[file] = (firedBy[file] ?? new Set()).add(rule);
	}
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("lint rules", () => {
	for (const [path, { fires }] of Object.entries(fixtures)) {
		it(`${path}: ${fires.length ? fires.join(", ") : "clean"}`, () => {
			expect([...(firedBy[path] ?? [])].sort()).toEqual([...fires].sort());
		});
	}
});
