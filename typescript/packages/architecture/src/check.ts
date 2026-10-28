import { clearCaches } from "@typescript-eslint/parser";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import { ESLint } from "eslint";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { dependencyCruiserConfig, dependencyCruiserRules, type DependencyCruiserOptions } from "./dependency-cruiser.js";
import { DESIGN_RULE_DEFAULTS, projectedEslint, type DesignRules } from "./eslint.js";
import { checkLayout, type Violation } from "./layout.js";

export interface CheckOptions extends DependencyCruiserOptions {
  /** Levels for the configurable design rules. Defaults to the project's projected.json. */
  readonly designRules?: DesignRules;
  /**
   * Check these files only (relative to the root) — what an agent just changed — and the modules
   * they import. The layout is always checked whole. Files outside `src/` and `test/` are ignored.
   */
  readonly files?: readonly string[];
}

export interface CheckReport {
  /** Errors: the check fails while there are any. */
  readonly violations: readonly Violation[];
  /** Design rules set to "warn": reported, and failing only under `projected check --strict`. */
  readonly warnings: readonly Violation[];
  /** Files each tool looked at — a check that saw nothing proves nothing. */
  readonly checked: { readonly dependencyCruiser: number; readonly eslint: number };
}

/**
 * Run every architecture check on a project: layout and layer tsconfigs, import boundaries
 * (dependency-cruiser) and code rules (ESLint). Uses projected's own rule sets, never the
 * project's local config files, so the result cannot be weakened from inside the project.
 *
 * A check that inspects zero files is reported as a violation: several of these tools pass
 * silently when misconfigured, and a green run that checked nothing is the worst outcome.
 */
export async function checkArchitecture(root: string, options: CheckOptions = {}): Promise<CheckReport> {
  const violations: Violation[] = [...checkLayout(root)];
  if (!existsSync(join(root, "src"))) {
    return { violations, warnings: [], checked: { dependencyCruiser: 0, eslint: 0 } };
  }

  const scoped = options.files?.filter((file) => /^(src|test)\/.*\.(ts|mts|cts|tsx)$/.test(file) && existsSync(join(root, file)));
  if (scoped !== undefined && scoped.length === 0) return { violations, warnings: [], checked: { dependencyCruiser: 0, eslint: 0 } };

  const comments = new Map(dependencyCruiserRules(options).map((rule) => [rule.name, rule.comment ?? ""]));
  const config = dependencyCruiserConfig(options);
  const { options: cruiseOptions = {} } = config;
  const { tsConfig: _tsConfig, ...rest } = cruiseOptions;
  // baseDir, not process.chdir: the working directory is process-wide, and worker threads (test
  // runners, mutation testing) may not change it at all.
  const result = await cruise(
    // Tests too, so that test code cannot reach for the other flavour either.
    scoped !== undefined ? [...scoped] : existsSync(join(root, "test")) ? ["src", "test"] : ["src"],
    { ...rest, baseDir: root, ruleSet: { forbidden: config.forbidden ?? [] }, validate: true, outputType: "json" },
    {
      extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"], ".cjs": [".cts", ".cjs"] },
      // Resolve packages the way Node does, including subpath exports (`better-auth/plugins`).
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "types", "default", "require"],
      mainFields: ["module", "main", "types"],
    },
  );
  const cruised = (typeof result.output === "string" ? JSON.parse(result.output) : result.output) as ICruiseResult;
  for (const violation of cruised.summary.violations) {
    violations.push({
      tool: "dependency-cruiser",
      rule: violation.rule.name,
      file: violation.from,
      message: `imports ${violation.unresolvedTo ?? violation.to}: ${comments.get(violation.rule.name) ?? ""}`.trim(),
    });
  }
  const cruisedFiles = cruised.modules.filter((module) => module.source.startsWith("src/")).length;

  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: projectedEslint({ tsconfigRootDir: root, ...(options.designRules === undefined ? {} : { designRules: options.designRules }) }),
  });
  const warnings: Violation[] = [];
  // Typed rules keep a TypeScript program per tsconfig in a process-wide cache; release them, or
  // a process that checks many projects (a test suite, an agent loop) runs out of memory.
  const lintTargets = scoped === undefined ? ["src/**/*.{ts,mts,cts,tsx}"] : scoped.filter((file) => file.startsWith("src/"));
  const results = lintTargets.length === 0 ? [] : await eslint.lintFiles(lintTargets).finally(() => clearCaches());
  const designRules = new Set(Object.keys(DESIGN_RULE_DEFAULTS).map((rule) => `projected/${rule}`));
  for (const result of results) {
    for (const message of result.messages) {
      (message.severity === 1 && designRules.has(message.ruleId ?? "") ? warnings : violations).push({
        tool: "eslint",
        rule: message.ruleId ?? (message.fatal ? "parse-error" : "inline-config"),
        file: relative(root, result.filePath),
        line: message.line,
        message: message.message,
      });
    }
  }

  const checked = { dependencyCruiser: cruisedFiles, eslint: results.length };
  if (scoped === undefined && (checked.dependencyCruiser === 0 || checked.eslint === 0)) {
    violations.push({
      tool: checked.dependencyCruiser === 0 ? "dependency-cruiser" : "eslint",
      rule: "checked-nothing",
      file: "src",
      message: "The check inspected no source files, so it proves nothing. Is src/ empty or excluded?",
    });
  }
  return { violations, warnings, checked };
}

/** Human-readable report, one violation per line, grouped by file. */
export function formatViolations(violations: readonly Violation[]): string {
  return [...violations]
    .sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0))
    .map((v) => `${v.file}${v.line === undefined ? "" : `:${v.line}`}  [${v.tool}/${v.rule}]  ${v.message}`)
    .join("\n");
}
