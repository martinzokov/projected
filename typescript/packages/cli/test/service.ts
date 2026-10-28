import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { newService } from "@projected/cli";

/** Generated services for the CLI's tests, in the workspace so that the framework resolves. */

const here = dirname(fileURLToPath(import.meta.url));
const workspace = join(here, "..", "..", "..");
export const scratch = join(here, "..", ".tsbuild", "scaffold");
const require = createRequire(import.meta.url);
export const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
export const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
export const projected = join(here, "..", "bin", "projected.js");
const exec = promisify(execFile);
const services: string[] = [];

/**
 * Remove the services this test file created. Only those: test files run in parallel, and the
 * scratch directory is shared with the ones still running.
 */
export const removeScratch = () => services.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));

export type Flavour = "event-sourced" | "state-based";

/** A new service in the workspace, with the framework and its other dependencies linked as `pnpm install` would. */
export function service(flavour: Flavour, aggregate = "invoice"): string {
  mkdirSync(scratch, { recursive: true });
  const parent = mkdtempSync(join(scratch, "service-"));
  services.push(parent);
  const root = join(parent, "billing");
  const created = newService(parent, "billing", { flavour, aggregate });
  if (!created.ok) throw new Error(created.lines.join("\n"));
  mkdirSync(join(root, "node_modules", "@projected"), { recursive: true });
  for (const name of readdirSync(join(workspace, "packages"))) {
    symlinkSync(join(workspace, "packages", name), join(root, "node_modules", "@projected", name), "dir");
  }
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  symlinkSync(projected, join(root, "node_modules", ".bin", "projected"));
  const installed = join(workspace, "examples", "school-event-sourced", "node_modules");
  for (const name of ["better-auth", "pg", "@types/pg", "@opentelemetry/api"]) {
    mkdirSync(dirname(join(root, "node_modules", name)), { recursive: true });
    symlinkSync(realpathSync(join(installed, name)), join(root, "node_modules", name), "dir");
  }
  return root;
}

/** Every file of the service but its dependencies, with its content. */
export function files(root: string, dir = root): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") Object.assign(found, files(root, path));
    else if (entry.isFile()) found[relative(root, path)] = readFileSync(path, "utf8");
  }
  return found;
}

export const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");

/** Run a tool in the generated service as its developer would, outside this test runner. */
export async function inService(root: string, script: string, ...args: string[]): Promise<{ code: number; output: string }> {
  // Plain output, whatever the runner's terminal: CI forces colour, which splits up the summary.
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && key !== "FORCE_COLOR")),
    NO_COLOR: "1",
  };
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args], { cwd: root, env, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}
