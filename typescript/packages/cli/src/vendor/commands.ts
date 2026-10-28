import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CommandResult } from "../commands.js";
import type { Project, VendorConfig } from "../project.js";
import { compareSpecs, type SpecChange } from "./diff.js";
import { generateClient, starterFiles, vendorPaths } from "./generate.js";
import { camel } from "./zod.js";
import { canonicalSpec, parseSpec, readSpecSource, specHash, type OpenApiDocument } from "./spec.js";

const pass = (...lines: string[]): CommandResult => ({ ok: true, lines });
const failWith = (...lines: string[]): CommandResult => ({ ok: false, lines });
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function write(root: string, path: string, content: string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function saveConfig(project: Project, vendors: Readonly<Record<string, VendorConfig>>) {
  const path = join(project.root, "projected.json");
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(path, `${JSON.stringify({ ...current, vendors }, null, 2)}\n`);
}

/** A source as recorded in projected.json: URLs as given, files relative to the project root. */
const recorded = (project: Project, source: string) =>
  /^https?:\/\//.test(source) ? source : relative(project.root, isAbsolute(source) ? source : resolve(source));
const located = (project: Project, source: string) =>
  /^https?:\/\//.test(source) || isAbsolute(source) ? source : join(project.root, source);

async function load(source: string): Promise<OpenApiDocument> {
  return parseSpec(await readSpecSource(source), source);
}

function render(name: string, document: OpenApiDocument): { pinned: string; client: string } {
  const pinned = canonicalSpec(document);
  const paths = vendorPaths(name);
  return { pinned, client: generateClient({ name, document, specPath: paths.spec, specHash: specHash(pinned) }) };
}

function describe(changes: readonly SpecChange[]): string[] {
  return changes.map((change) => `  ${change.breaking ? "BREAKING " : ""}${change.operation}: ${change.description}`);
}

/** `projected vendor add <name> --spec <url|file>` */
export async function vendorAdd(project: Project, name: string | undefined, source: string | undefined): Promise<CommandResult> {
  if (name === undefined || !KEBAB.test(name)) return failWith("vendor add: give the vendor a kebab-case name: `projected vendor add weather --spec <url|file>`.");
  if (source === undefined) return failWith(`vendor add: say where the OpenAPI spec is: \`projected vendor add ${name} --spec <url|file>\`.`);
  const vendors = project.config.vendors ?? {};
  if (vendors[name] !== undefined) return failWith(`vendor add: ${name} already exists. Use \`projected vendor update ${name}\` to take a new spec.`);

  const document = await load(located(project, source));
  const paths = vendorPaths(name);
  const { pinned, client } = render(name, document);
  write(project.root, paths.spec, pinned);
  write(project.root, paths.client, client);
  const starters = starterFiles(name);
  const created = [paths.spec, paths.client];
  for (const [path, content] of [
    [paths.port, starters.port],
    [paths.adapter, starters.adapter],
  ] as const) {
    if (!existsSync(join(project.root, path))) {
      write(project.root, path, content);
      created.push(path);
    }
  }
  saveConfig(project, { ...vendors, [name]: { spec: paths.spec, source: recorded(project, source) } });
  return pass(
    `vendor: added ${name} — ${created.join(", ")}`,
    `vendor: describe what the app needs in ${paths.port}, map it onto the client in ${paths.adapter},`,
    `        and wire ${camel(name)}Adapter(${camel(name)}Client(httpClient({ dependency: "${name}", baseUrl, telemetry }))) in the composition root.`,
  );
}

/** `projected vendor update <name> [--spec <url|file>] [--accept-breaking]` */
export async function vendorUpdate(
  project: Project,
  name: string | undefined,
  options: { source?: string; acceptBreaking: boolean },
): Promise<CommandResult> {
  const vendor = name === undefined ? undefined : project.config.vendors?.[name];
  if (name === undefined || vendor === undefined) return failWith(`vendor update: unknown vendor ${name ?? "(none given)"}. Add it first with \`projected vendor add\`.`);
  const source = options.source ?? vendor.source;
  if (source === undefined) return failWith(`vendor update: ${name} records no source. Pass --spec <url|file>.`);

  const pinnedPath = join(project.root, vendor.spec);
  const previous = parseSpec(readFileSync(pinnedPath, "utf8"), vendor.spec);
  const next = await load(located(project, source));
  const changes = compareSpecs(previous, next);
  const breaking = changes.filter((change) => change.breaking);
  if (breaking.length > 0 && !options.acceptBreaking) {
    return failWith(
      `vendor: ${name}'s new spec has ${breaking.length} breaking change(s) — nothing was written:`,
      ...describe(changes),
      `  Check what the adapter relies on, then accept them with \`projected vendor update ${name} --accept-breaking\` and fix what no longer compiles.`,
    );
  }
  const { pinned, client } = render(name, next);
  write(project.root, vendor.spec, pinned);
  write(project.root, vendorPaths(name).client, client);
  if (options.source !== undefined) saveConfig(project, { ...project.config.vendors, [name]: { ...vendor, source: recorded(project, source) } });
  return pass(
    changes.length === 0 ? `vendor: ${name} is unchanged` : `vendor: updated ${name}:`,
    ...describe(changes),
  );
}

/** `projected vendor generate [<name>]`: regenerate clients from the pinned specs, without fetching anything. */
export function vendorGenerate(project: Project, name: string | undefined): CommandResult {
  const vendors = Object.entries(project.config.vendors ?? {}).filter(([vendor]) => name === undefined || vendor === name);
  if (name !== undefined && vendors.length === 0) return failWith(`vendor generate: unknown vendor ${name}.`);
  for (const [vendor, config] of vendors) {
    const document = parseSpec(readFileSync(join(project.root, config.spec), "utf8"), config.spec);
    write(project.root, vendorPaths(vendor).client, render(vendor, document).client);
  }
  return pass(`vendor: regenerated ${vendors.map(([vendor]) => vendor).join(", ") || "nothing (no vendors)"}`);
}

/** For `projected check`: every generated client matches its pinned spec. */
export function vendorCheck(project: Project): CommandResult {
  const vendors = Object.entries(project.config.vendors ?? {});
  if (vendors.length === 0) return pass("vendor: no vendors");
  const problems: string[] = [];
  for (const [vendor, config] of vendors) {
    const specFile = join(project.root, config.spec);
    if (!existsSync(specFile)) {
      problems.push(`  ${vendor}: ${config.spec} is missing — restore it, or re-add the vendor.`);
      continue;
    }
    const document = parseSpec(readFileSync(specFile, "utf8"), config.spec);
    const clientPath = vendorPaths(vendor).client;
    const actual = existsSync(join(project.root, clientPath)) ? readFileSync(join(project.root, clientPath), "utf8") : undefined;
    if (actual !== render(vendor, document).client) {
      problems.push(`  ${vendor}: ${clientPath} does not match ${config.spec} — run \`projected vendor generate\` (never edit it by hand).`);
    }
  }
  return problems.length === 0
    ? pass(`vendor: ${vendors.length} generated client(s) match their pinned specs`)
    : failWith("vendor: generated clients are out of date", ...problems);
}
