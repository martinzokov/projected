import { checkArchitecture, formatViolations } from "@projected/architecture";
import { openApiDocument } from "@projected/http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { LOCKFILE_VERSION, compareLock, updateLock, type ContractsLock } from "./contracts-lock.js";
import { loadContracts, type Project } from "./project.js";

/** The outcome of one command: lines to print and whether it passed. */
export interface CommandResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

const pass = (...lines: string[]): CommandResult => ({ ok: true, lines });
const failWith = (...lines: string[]): CommandResult => ({ ok: false, lines });

export async function architecture(project: Project, options: { strict?: boolean } = {}): Promise<CommandResult> {
  const report = await checkArchitecture(project.root, {
    flavour: project.flavour,
    designRules: project.config.rules ?? {},
    ...(project.config.applicationPackages === undefined ? {} : { applicationPackages: project.config.applicationPackages }),
    ...(project.config.domainPackages === undefined ? {} : { domainPackages: project.config.domainPackages }),
  });
  const summary = `checked ${report.checked.dependencyCruiser} modules (imports) and ${report.checked.eslint} files (code rules)`;
  const warnings =
    report.warnings.length === 0
      ? []
      : [
          `architecture: ${report.warnings.length} warning(s)${options.strict ? " — failing: --strict" : " (set the rule to \"error\" in projected.json, or run with --strict, to fail on them)"}`,
          formatViolations(report.warnings),
        ];
  const failing = report.violations.length > 0 || (options.strict === true && report.warnings.length > 0);
  if (!failing) return pass(`architecture (${project.flavour}): ok — ${summary}`, ...warnings);
  return failWith(
    `architecture (${project.flavour}): ${report.violations.length} violation(s) — ${summary}`,
    ...(report.violations.length === 0 ? [] : [formatViolations(report.violations)]),
    ...warnings,
  );
}

const render = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export async function openapi(project: Project, options: { check: boolean }): Promise<CommandResult> {
  const contracts = await loadContracts(project);
  const document = render(
    openApiDocument(contracts, {
      version: project.version,
      ...(project.config.securitySchemes === undefined ? {} : { securitySchemes: project.config.securitySchemes }),
    }),
  );
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
  options: { update: boolean; allowRemoval: boolean; rebaseline?: boolean },
): Promise<CommandResult> {
  const file = relative(project.root, project.lockPath);
  const lock = existsSync(project.lockPath) ? (JSON.parse(readFileSync(project.lockPath, "utf8")) as ContractsLock) : undefined;
  if (lock?.flavour !== undefined && lock.flavour !== project.flavour) {
    return failWith(
      `contracts: this project was created ${lock.flavour} (${file}), but projected.json now says ${project.flavour}.`,
      `  A project's flavour never changes: set "flavour" back to "${lock.flavour}". To move to ${project.flavour}, ` +
        "create a new service with `projected new service` and migrate the data into it.",
    );
  }
  const contracts = await loadContracts(project);
  if (lock !== undefined && lock.lockfileVersion !== LOCKFILE_VERSION && !options.rebaseline) {
    return failWith(
      `contracts: ${file} is lockfile version ${lock.lockfileVersion}; this projected fingerprints contracts as version ${LOCKFILE_VERSION}.`,
      "  Upgrade it with `projected contracts --rebaseline` — fingerprints change format, not your contracts.",
    );
  }
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

  if (options.rebaseline) {
    writeFileSync(
      project.lockPath,
      render(updateLock(lock, contracts, { allowRemoval: options.allowRemoval, rebaseline: true, flavour: project.flavour })),
    );
    return pass(
      `contracts: rebaselined ${file}${changed.length > 0 ? ` — accepted new fingerprints for ${changed.join(", ")}` : ""}`,
      "contracts: only do this after a toolchain upgrade, and only if the openapi.json diff shows no change to any published operation.",
    );
  }
  if (options.update) {
    writeFileSync(project.lockPath, render(updateLock(lock, contracts, { allowRemoval: options.allowRemoval, flavour: project.flavour })));
    const accepted = [...added, ...(options.allowRemoval ? removed.map((key) => `${key} (removed)`) : [])];
    const lines = [`contracts: updated ${file}${accepted.length > 0 ? ` — ${accepted.join(", ")}` : ""}`];
    return problems.length === 0 ? pass(...lines) : failWith(...lines, "contracts: published operations changed:", ...problems);
  }
  for (const key of added) problems.push(`  ${key} is new and not locked yet — run \`projected contracts --update\`.`);
  if (lock !== undefined && lock.flavour === undefined) {
    problems.push(`  ${file} does not record the project's flavour yet — run \`projected contracts --update\`.`);
  }
  if (problems.length === 0) return pass(`contracts: ${file} matches all ${Object.keys(lock?.operations ?? {}).length} operations`);
  return failWith(`contracts: ${file} does not match the code`, ...problems);
}
