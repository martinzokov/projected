import { checkArchitecture, formatViolations } from "@projected/architecture";
import { openApiDocument } from "@projected/http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { compareLock, updateLock, type ContractsLock } from "./contracts-lock.js";
import { loadContracts, type Project } from "./project.js";

/** The outcome of one command: lines to print and whether it passed. */
export interface CommandResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

const pass = (...lines: string[]): CommandResult => ({ ok: true, lines });
const failWith = (...lines: string[]): CommandResult => ({ ok: false, lines });

export async function architecture(project: Project): Promise<CommandResult> {
  const report = await checkArchitecture(project.root, {
    ...(project.config.applicationPackages === undefined ? {} : { applicationPackages: project.config.applicationPackages }),
    ...(project.config.domainPackages === undefined ? {} : { domainPackages: project.config.domainPackages }),
  });
  const summary = `checked ${report.checked.dependencyCruiser} modules (imports) and ${report.checked.eslint} files (code rules)`;
  if (report.violations.length === 0) return pass(`architecture: ok — ${summary}`);
  return failWith(
    `architecture: ${report.violations.length} violation(s) — ${summary}`,
    formatViolations(report.violations),
  );
}

const render = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export async function openapi(project: Project, options: { check: boolean }): Promise<CommandResult> {
  const contracts = await loadContracts(project);
  const document = render(openApiDocument(contracts, { version: project.version }));
  const file = relative(project.root, project.openapiPath);
  if (!options.check) {
    writeFileSync(project.openapiPath, document);
    return pass(`openapi: wrote ${file}`);
  }
  if (!existsSync(project.openapiPath)) return failWith(`openapi: ${file} is missing — run \`projected openapi\``);
  return readFileSync(project.openapiPath, "utf8") === document
    ? pass(`openapi: ${file} is up to date`)
    : failWith(`openapi: ${file} is out of date — run \`projected openapi\` and commit the result`);
}

export async function contractsLock(
  project: Project,
  options: { update: boolean; allowRemoval: boolean },
): Promise<CommandResult> {
  const contracts = await loadContracts(project);
  const file = relative(project.root, project.lockPath);
  const lock = existsSync(project.lockPath) ? (JSON.parse(readFileSync(project.lockPath, "utf8")) as ContractsLock) : undefined;
  const { added, changed, removed } = lock === undefined
    ? { added: [...contracts.commands, ...contracts.queries].map((c) => `${c.kind} ${c.key}`), changed: [], removed: [] }
    : compareLock(lock, contracts);

  const problems: string[] = [];
  for (const key of changed) {
    problems.push(
      `  ${key} changed after it was published. Clients depend on it: revert the change and add ` +
        `version ${Number(key.split("@")[1]) + 1} instead (deprecate this one with deprecated: true).`,
    );
  }
  if (!options.allowRemoval) {
    for (const key of removed) {
      problems.push(
        `  ${key} was removed. That breaks every client still calling it: deprecate it first, and remove it ` +
          "with `projected contracts --update --allow-removal` once nothing uses it.",
      );
    }
  }

  if (options.update) {
    writeFileSync(project.lockPath, render(updateLock(lock, contracts, { allowRemoval: options.allowRemoval })));
    const accepted = [...added, ...(options.allowRemoval ? removed.map((key) => `${key} (removed)`) : [])];
    const lines = [`contracts: updated ${file}${accepted.length > 0 ? ` — ${accepted.join(", ")}` : ""}`];
    return problems.length === 0 ? pass(...lines) : failWith(...lines, "contracts: published operations changed:", ...problems);
  }
  for (const key of added) problems.push(`  ${key} is new and not locked yet — run \`projected contracts --update\`.`);
  if (problems.length === 0) return pass(`contracts: ${file} matches all ${Object.keys(lock?.operations ?? {}).length} operations`);
  return failWith(`contracts: ${file} does not match the code`, ...problems);
}
