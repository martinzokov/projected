import { DependencyUnavailable, Result, panic } from "@projected/application";
import { Kysely, PostgresDialect, sql, type Dialect } from "kysely";
import type pg from "pg";
import type { ProjectedDatabase } from "./database.js";

/**
 * The adapters' connection: a Kysely instance over projected's tables, so every query is built
 * from typed table and column names rather than SQL strings. `fromPool` covers node-postgres;
 * `fromDialect` any other Kysely dialect (a serverless driver, PGlite).
 */
export type PostgresClient = Kysely<ProjectedDatabase>;

/** A {@link PostgresClient} over a node-postgres pool. Ending the pool is the caller's, as before. */
export function fromPool(pool: pg.Pool): PostgresClient {
  return new Kysely<ProjectedDatabase>({ dialect: new PostgresDialect({ pool }) });
}

/** A {@link PostgresClient} over any Kysely dialect for PostgreSQL. */
export function fromDialect(dialect: Dialect): PostgresClient {
  return new Kysely<ProjectedDatabase>({ dialect });
}

export interface PostgresOptions {
  /** Schema holding projected's tables. Defaults to `projected`. */
  readonly schema?: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** The schema name, validated: it also names the advisory locks below. */
export function schemaOf(options: PostgresOptions = {}): string {
  const schema = options.schema ?? "projected";
  if (!IDENTIFIER.test(schema)) panic(`Postgres schema "${schema}" must be a lower-case SQL identifier`);
  return schema;
}

/** The client with every unqualified table in the project's schema. */
export const inSchema = (db: PostgresClient, options: PostgresOptions = {}): PostgresClient => db.withSchema(schemaOf(options));

/**
 * Wait for the transaction-scoped advisory lock `name` in `schema`. The key text is the one the
 * adapters have always used, so instances of an older version and this one exclude each other.
 */
export function advisoryLock(db: PostgresClient, name: string, schema: string): Promise<unknown> {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${`${name}:"${schema}"`}))`.execute(db);
}

/** Run a query, turning any driver failure into a `DependencyUnavailable` that names the cause. */
export async function attempt<T>(dependency: string, work: () => Promise<T>): Promise<Result<T, DependencyUnavailable>> {
  try {
    return Result.ok(await work());
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    const hint = code === "42P01" ? " (tables missing — run migrate())" : "";
    return Result.err(
      new DependencyUnavailable({ dependency, message: `${dependency}: ${(cause as Error).message ?? String(cause)}${hint}`, cause }),
    );
  }
}
