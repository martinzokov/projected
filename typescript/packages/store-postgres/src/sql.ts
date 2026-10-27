import { DependencyUnavailable, Result, panic } from "@projected/application";
import type pg from "pg";

/**
 * The little the adapters need from a Postgres driver. `fromPool` adapts node-postgres; anything
 * else that can run parameterised queries and transactions (a serverless driver, PGlite) can
 * implement it in a few lines.
 */
export interface SqlClient {
  query<Row extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
  /** Run `work` in a transaction: committed when it resolves, rolled back when it throws. */
  transaction<T>(work: (tx: SqlClient) => Promise<T>): Promise<T>;
}

/** A {@link SqlClient} over a node-postgres pool. */
export function fromPool(pool: pg.Pool): SqlClient {
  return {
    query: async <Row extends object>(text: string, params?: readonly unknown[]) =>
      pool.query(text, params as unknown[]) as unknown as Promise<{ rows: Row[] }>,
    transaction: async (work) => {
      const client = await pool.connect();
      const tx: SqlClient = {
        query: async <Row extends object>(text: string, params?: readonly unknown[]) =>
          client.query(text, params as unknown[]) as unknown as Promise<{ rows: Row[] }>,
        transaction: (nested) => nested(tx),
      };
      try {
        await client.query("BEGIN");
        const result = await work(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export interface PostgresOptions {
  /** Schema holding projected's tables. Defaults to `projected`. */
  readonly schema?: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** The quoted schema name, validated so it can be interpolated into SQL. */
export function schemaOf(options: PostgresOptions = {}): string {
  const schema = options.schema ?? "projected";
  if (!IDENTIFIER.test(schema)) panic(`Postgres schema "${schema}" must be a lower-case SQL identifier`);
  return `"${schema}"`;
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
