import type { SchemaMigrator } from "@projected/application";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { CommandResult } from "./commands.js";
import type { Project } from "./project.js";

/** What a service's migrations module gives `projected migrate`: every set of tables it keeps, in order. */
export interface Migrations {
  readonly migrators: readonly SchemaMigrator[];
  /** Let go of the connections the migrators use. */
  close?(): Promise<void>;
}

const DEFAULT_MODULE = "src/infrastructure/config/migrations.ts";

const isMigrations = (value: unknown): value is Migrations =>
  typeof value === "object" && value !== null && Array.isArray((value as Migrations).migrators);

/**
 * Import the service's migrations module (TypeScript, loaded with tsx) and call its
 * `migrations(env)`. The module is the service's own, so it decides where the tables live — a
 * generated service reads DATABASE_URL — and lists the same migrators the service checks at start.
 */
export async function loadMigrations(project: Project, env: NodeJS.ProcessEnv = process.env): Promise<Migrations> {
  const modulePath = join(project.root, project.config.migrations ?? DEFAULT_MODULE);
  if (!existsSync(modulePath)) {
    throw new Error(
      `Migrations module not found: ${modulePath}. Export \`migrations(env)\` from it, returning { migrators, close } ` +
        `(as a generated service does), or set "migrations" in projected.json.`,
    );
  }
  const module = (await tsImport(pathToFileURL(modulePath).href, import.meta.url)) as Record<string, unknown>;
  if (typeof module.migrations !== "function") throw new Error(`${modulePath} must export a function \`migrations(env)\`.`);
  const migrations: unknown = await (module.migrations as (env: NodeJS.ProcessEnv) => unknown)(env);
  if (!isMigrations(migrations)) throw new Error(`\`migrations(env)\` in ${modulePath} must return { migrators: SchemaMigrator[], close? }.`);
  if (migrations.migrators.length === 0) {
    await migrations.close?.();
    throw new Error(
      `${relative(project.root, modulePath)} found nothing to migrate. Point it at the database: a generated service reads DATABASE_URL.`,
    );
  }
  return migrations;
}

/**
 * `projected migrate`: bring the service's tables up to date as a deploy step, before the new
 * version starts — a failed migration then stops the rollout instead of every new instance, and
 * the running service's database role needs no right to change tables. Migrators run in order and
 * the first failure stops the rest. With `check`, nothing changes and pending changes fail.
 */
export async function migrate(migrations: Migrations, options: { readonly check?: boolean } = {}): Promise<CommandResult> {
  const lines: string[] = [];
  let pending = 0;
  for (const migrator of migrations.migrators) {
    const outcome = options.check ? await migrator.pending() : await migrator.apply();
    if (outcome.isErr()) return { ok: false, lines: [...lines, `${migrator.name}: ${outcome.error.message}`] };
    const changes = outcome.value;
    pending += changes.length;
    lines.push(`${migrator.name}: ${changes.length === 0 ? "up to date" : `${options.check ? "pending" : "applied"} ${changes.join(", ")}`}`);
  }
  if (options.check && pending > 0) {
    return { ok: false, lines: [...lines, `migrate: ${pending} change(s) pending — run \`projected migrate\` before starting this version`] };
  }
  return { ok: true, lines };
}
