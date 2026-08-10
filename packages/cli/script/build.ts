#!/usr/bin/env bun

import { $ } from "bun";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

await $`rm -rf dist`;
await $`bun run tsc --noEmit -p tsconfig.json`;

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "bun",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await chmod("dist/index.js", 0o755);
