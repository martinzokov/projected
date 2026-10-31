#!/usr/bin/env node
// The CLI finds the agent skills and the conformance scenarios by walking up from its own module
// (see `skillsRoot` in src/agents.ts and `specDir` in src/conformance.ts). In the repository they
// are at its root; in the published package they must be inside it. `prepack` copies them in with
// the same layout, `postpack` removes the copies so the workspace keeps reading the originals.
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(pkg, "..", "..", "..");
const ASSETS = ["skills", "vendor/anti-slop/skills", "spec"];

const mode = process.argv[2];
if (mode !== "copy" && mode !== "clean") {
  console.error("usage: pack-assets.mjs copy | clean");
  process.exit(2);
}
rmSync(join(pkg, "skills"), { recursive: true, force: true });
rmSync(join(pkg, "vendor"), { recursive: true, force: true });
rmSync(join(pkg, "spec"), { recursive: true, force: true });
if (mode === "copy") {
  for (const asset of ASSETS) cpSync(join(repo, asset), join(pkg, asset), { recursive: true });
}
