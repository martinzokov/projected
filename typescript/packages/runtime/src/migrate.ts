import type { SchemaMigrator } from "@projected/application";

/** What a migration run says, line by line, and whether it succeeded. */
export interface MigrationRun {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/**
 * Bring the tables up to date as a deploy step: apply each migrator's pending changes in order,
 * stopping at the first failure — or, with `check`, change nothing and fail while anything is
 * pending. What `projected migrate` runs, and a built service's `migrate.js` without the CLI.
 */
export async function runMigrations(migrators: readonly SchemaMigrator[], options: { readonly check?: boolean } = {}): Promise<MigrationRun> {
  if (migrators.length === 0) {
    return { ok: false, lines: ["migrate: nothing to migrate — point the migrations module at the database (a generated service reads DATABASE_URL)"] };
  }
  const lines: string[] = [];
  let pending = 0;
  for (const migrator of migrators) {
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
