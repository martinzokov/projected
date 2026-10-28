import { DependencyFailure, Result, type DependencyUnavailable, type SchemaMigrator } from "@projected/application";

export interface PrepareSchemaOptions {
  /**
   * Apply pending changes (the default), or only check that there are none: for when
   * `projected migrate` runs as a deploy step, so the service's database role need not be able
   * to change tables and a failed migration stops the rollout before any instance starts.
   */
  readonly apply?: boolean;
}

/**
 * Get the service's tables ready before it serves: apply each migrator's pending changes in
 * order, or, with `apply: false`, refuse to start against tables that are behind. Returns what
 * was applied, as `name: change`.
 */
export async function prepareSchema(
  migrators: readonly SchemaMigrator[],
  options: PrepareSchemaOptions = {},
): Promise<Result<readonly string[], DependencyUnavailable | DependencyFailure>> {
  const apply = options.apply ?? true;
  const changes: string[] = [];
  const behind: string[] = [];
  for (const migrator of migrators) {
    const outcome = apply ? await migrator.apply() : await migrator.pending();
    if (outcome.isErr()) return Result.err(outcome.error);
    if (outcome.value.length > 0) behind.push(`${migrator.name}: ${outcome.value.join(", ")}`);
    changes.push(...outcome.value.map((change) => `${migrator.name}: ${change}`));
  }
  if (!apply && behind.length > 0) {
    return Result.err(
      new DependencyFailure({
        dependency: "schema",
        message: `The tables are behind this version (pending ${behind.join("; ")}). Run \`projected migrate\` before starting it.`,
      }),
    );
  }
  return Result.ok(changes);
}
