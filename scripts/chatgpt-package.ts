import { mkdirSync, writeFileSync } from "node:fs";
import { chatGptPackageZip } from "../src/site/chatgpt-package";

// Writes dist/better-giving-chatgpt.zip from the repo root (`pnpm chatgpt:package`).
const out = "dist/better-giving-chatgpt.zip";
mkdirSync("dist", { recursive: true });
writeFileSync(out, chatGptPackageZip());
process.stdout.write(`${out}\n`);
