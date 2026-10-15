import { register } from "node:module";

// tsx has no binary loader. The demo import is the file's bytes, the same
// shape esbuild's `.mp4` binary loader and the vitest plugin produce.
register("./mp4-hook.mjs", import.meta.url);
