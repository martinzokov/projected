import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandResult } from "../commands.js";
import { loadContracts, type Project } from "../project.js";
import { analyze } from "./analyze.js";
import { renderCatalog } from "./render.js";

const pathOf = (project: Project) => project.config.docs ?? "docs/catalog.md";

async function catalog(project: Project): Promise<string> {
  return renderCatalog(await loadContracts(project), analyze(project.root), project.flavour);
}

/** `projected docs [--check]`: write the service catalog, or verify it is current. */
export async function docs(project: Project, options: { check: boolean }): Promise<CommandResult> {
  const file = pathOf(project);
  const path = join(project.root, file);
  const content = await catalog(project);
  if (!options.check) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return { ok: true, lines: [`docs: wrote ${file}`] };
  }
  if (!existsSync(path)) return { ok: false, lines: [`docs: ${file} is missing — run \`projected docs\` and commit it`] };
  return readFileSync(path, "utf8") === content
    ? { ok: true, lines: [`docs: ${file} is up to date`] }
    : { ok: false, lines: [`docs: ${file} is out of date — run \`projected docs\` and commit the result`] };
}
