import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandResult } from "./commands.js";
import type { Project } from "./project.js";

/** `mutation` in projected.json. */
export interface MutationConfig {
  /** The lowest acceptable mutation score, 0–100. Defaults to 70. */
  readonly threshold?: number;
  /**
   * Files to mutate. Defaults to the domain and the use cases: ports are declarations, and the
   * contract lock and HTTP tests already hold their schemas.
   */
  readonly mutate?: readonly string[];
}

/** The slice of a Stryker mutant result this command reads. */
interface MutantResult {
  readonly status: string;
  readonly fileName: string;
  readonly mutatorName: string;
  readonly replacement?: string;
  readonly location: { readonly start: { readonly line: number } };
}

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

/**
 * `projected mutate`: mutation testing of the domain and the use cases with Stryker. Every
 * mutant is a small change to the code (a condition flipped, a value emptied); a test suite that
 * still passes with it in place does not check that behaviour. The score is the share of mutants
 * some test noticed, and the run fails below the project's threshold.
 *
 * Tests run through vitest's own CLI, one process per mutant, with `PROJECTED_MUTATION` set so
 * that tests about code shape (architecture checks) can skip the instrumented copies.
 */
export async function mutate(project: Project): Promise<CommandResult> {
  const config = project.config.mutation ?? {};
  const threshold = config.threshold ?? 70;
  if (!(threshold >= 0 && threshold <= 100)) {
    return { ok: false, lines: [`mutate: "mutation.threshold" in projected.json must be a score from 0 to 100, found ${JSON.stringify(config.threshold)}.`] };
  }
  const require = createRequire(join(project.root, "package.json"));
  let strykerEntry: string;
  let vitestEntry: string;
  try {
    strykerEntry = require.resolve("@stryker-mutator/core");
    vitestEntry = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  } catch {
    return {
      ok: false,
      lines: ["mutate: add the test tools to the project first: `pnpm add -D @stryker-mutator/core vitest`."],
    };
  }
  const vitestConfig = existsSync(join(project.root, "vitest.config.ts")) ? " --config vitest.config.ts" : "";
  const { Stryker } = (await import(pathToFileURL(strykerEntry).href)) as {
    Stryker: new (options: Record<string, unknown>) => { runMutationTest(): Promise<MutantResult[]> };
  };

  process.env["PROJECTED_MUTATION"] = "1";
  const previous = process.cwd();
  let results: MutantResult[];
  try {
    // Stryker sandboxes the working directory's project.
    process.chdir(project.root);
    results = await new Stryker({
      testRunner: "command",
      commandRunner: { command: `"${process.execPath}" "${vitestEntry}" run${vitestConfig} --reporter=dot --silent` },
      mutate: [...(config.mutate ?? ["src/domain/**/*.ts", "src/application/usecase/**/*.ts"])],
      coverageAnalysis: "off",
      reporters: ["progress", "html"],
      htmlReporter: { fileName: "reports/mutation/index.html" },
      tempDirName: ".stryker-tmp",
      cleanTempDir: "always",
      thresholds: { high: Math.max(threshold, 80), low: threshold, break: null },
      logLevel: "warn",
    }).runMutationTest();
  } finally {
    process.chdir(previous);
    delete process.env["PROJECTED_MUTATION"];
  }

  const detected = results.filter((r) => DETECTED.has(r.status)).length;
  const undetected = results.filter((r) => UNDETECTED.has(r.status));
  const score = detected + undetected.length === 0 ? 100 : (100 * detected) / (detected + undetected.length);
  const ok = score >= threshold;
  const lines = [
    `mutate: ${score.toFixed(1)}% of ${detected + undetected.length} mutants caught (threshold ${threshold}%) — report in reports/mutation/index.html`,
  ];
  const shown = undetected.slice(0, 25);
  if (shown.length > 0) {
    lines.push("mutate: no test fails when these changes are made — each is a behaviour to test:");
    for (const mutant of shown) {
      const file = relative(project.root, mutant.fileName);
      const change = mutant.replacement === undefined ? "" : ` → ${JSON.stringify(mutant.replacement).slice(0, 60)}`;
      lines.push(`  ${file}:${mutant.location.start.line}  ${mutant.mutatorName}${change}${mutant.status === "NoCoverage" ? " (no test runs this code)" : ""}`);
    }
    if (undetected.length > shown.length) lines.push(`  … and ${undetected.length - shown.length} more in the report`);
  }
  return { ok, lines };
}
