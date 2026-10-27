import {
  DependencyFailure,
  Result,
  type CheckpointStore,
  type DependencyUnavailable,
  type DocumentCollection,
  type DocumentStore,
  type IdempotencyClaim,
  type IdempotencyStore,
  type OperationResult,
  type z,
} from "@projected/application";
import { attempt, schemaOf, type PostgresOptions, type SqlClient } from "./sql.js";

/** A {@link CheckpointStore} on PostgreSQL. */
export function postgresCheckpointStore(sql: SqlClient, options: PostgresOptions = {}): CheckpointStore {
  const s = schemaOf(options);
  const dependency = "postgres checkpoints";
  return {
    load: (name) =>
      attempt(dependency, async () => {
        const { rows } = await sql.query<{ position: string }>(`SELECT position FROM ${s}.checkpoints WHERE name = $1`, [name]);
        return rows[0] === undefined ? 0 : Number(rows[0].position);
      }),
    save: (name, position) =>
      attempt(dependency, async () => {
        await sql.query(
          `INSERT INTO ${s}.checkpoints (name, position) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET position = EXCLUDED.position, updated_at = now()`,
          [name, position],
        );
      }),
  };
}

/**
 * An {@link IdempotencyStore} on PostgreSQL. Claims are one atomic upsert, so concurrent
 * requests with the same key — from any number of processes — get exactly one "claimed". Time
 * comes from the database, so application servers' clocks do not matter.
 */
export function postgresIdempotencyStore(sql: SqlClient, options: PostgresOptions = {}): IdempotencyStore & {
  /** Delete expired keys. Expired keys are already ignored; this only reclaims space — run it on a schedule. */
  purgeExpired(): Promise<Result<number, DependencyUnavailable>>;
} {
  const s = schemaOf(options);
  const dependency = "postgres idempotency";

  const claimOnce = async (key: string, fingerprint: string, lockMs: number, ttlMs: number): Promise<IdempotencyClaim | undefined> => {
    const claimed = await sql.query(
      `INSERT INTO ${s}.idempotency AS current (key, fingerprint, status, result, locked_until, expires_at)
       VALUES ($1, $2, 'in-progress', NULL, now() + $3 * interval '1 millisecond', now() + $4 * interval '1 millisecond')
       ON CONFLICT (key) DO UPDATE
         SET fingerprint = EXCLUDED.fingerprint, status = 'in-progress', result = NULL,
             locked_until = EXCLUDED.locked_until, expires_at = EXCLUDED.expires_at
         WHERE current.expires_at <= now() OR (current.status = 'in-progress' AND current.locked_until <= now())
       RETURNING key`,
      [key, fingerprint, lockMs, ttlMs],
    );
    if (claimed.rows.length > 0) return { status: "claimed" };
    const { rows } = await sql.query<{ fingerprint: string; status: "in-progress" | "completed"; result: OperationResult | null }>(
      `SELECT fingerprint, status, result FROM ${s}.idempotency WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    // Released between the two statements: try again.
    if (row === undefined) return undefined;
    return row.status === "completed" && row.result !== null
      ? { status: "completed", fingerprint: row.fingerprint, result: row.result }
      : { status: "in-progress", fingerprint: row.fingerprint };
  };

  return {
    claim: (key, fingerprint, { lockMs, ttlMs }) =>
      attempt(dependency, async () => {
        for (;;) {
          const claim = await claimOnce(key, fingerprint, lockMs, ttlMs);
          if (claim !== undefined) return claim;
        }
      }),
    complete: (key, result) =>
      attempt(dependency, async () => {
        await sql.query(`UPDATE ${s}.idempotency SET status = 'completed', result = $2 WHERE key = $1`, [key, JSON.stringify(result)]);
      }),
    release: (key) =>
      attempt(dependency, async () => {
        await sql.query(`DELETE FROM ${s}.idempotency WHERE key = $1 AND status = 'in-progress'`, [key]);
      }),
    purgeExpired: () =>
      attempt(dependency, async () => {
        const { rows } = await sql.query(`DELETE FROM ${s}.idempotency WHERE expires_at <= now() RETURNING key`);
        return rows.length;
      }),
  };
}

/**
 * A {@link DocumentStore} on PostgreSQL: one JSONB table for every collection, indexed for
 * containment. Filters compare each field for exact equality; ordering follows JSONB's (numbers
 * numerically, strings by the database collation), ties broken by id.
 */
export function postgresDocumentStore(sql: SqlClient, options: PostgresOptions = {}): DocumentStore {
  const s = schemaOf(options);

  const collection = <S extends z.ZodType>(name: string, schema: S): DocumentCollection<z.output<S>> => {
    type Doc = z.output<S>;
    const dependency = `postgres documents:${name}`;
    const decode = (id: string, raw: unknown): Result<Doc, DependencyFailure> => {
      const parsed = schema.safeParse(raw);
      return parsed.success
        ? Result.ok(parsed.data as Doc)
        : Result.err(
            new DependencyFailure({ dependency, message: `Stored document ${name}/${id} does not match its schema`, cause: parsed.error }),
          );
    };
    const decodeAll = (rows: ReadonlyArray<{ id: string; data: unknown }>): Result<Doc[], DependencyFailure> => {
      const documents: Doc[] = [];
      for (const row of rows) {
        const document = decode(row.id, row.data);
        if (document.isErr()) return Result.err(document.error);
        documents.push(document.value);
      }
      return Result.ok(documents);
    };

    return {
      get: async (id) => {
        const read = await attempt(dependency, () =>
          sql.query<{ id: string; data: unknown }>(`SELECT id, data FROM ${s}.documents WHERE collection = $1 AND id = $2`, [name, id]),
        );
        if (read.isErr()) return Result.err(read.error);
        const row = read.value.rows[0];
        return row === undefined ? Result.ok(undefined) : decode(id, row.data);
      },
      put: (id, document) =>
        attempt(dependency, async () => {
          await sql.query(
            `INSERT INTO ${s}.documents (collection, id, data) VALUES ($1, $2, $3)
             ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
            [name, id, JSON.stringify(document)],
          );
        }),
      delete: (id) =>
        attempt(dependency, async () => {
          await sql.query(`DELETE FROM ${s}.documents WHERE collection = $1 AND id = $2`, [name, id]);
        }),
      find: async (filter, findOptions = {}) => {
        const params: unknown[] = [name, JSON.stringify(filter)];
        const equalities = Object.entries(filter).map(([field, value]) => {
          params.push(field, JSON.stringify(value));
          return `data -> $${params.length - 1} = $${params.length}::jsonb`;
        });
        let order = `id COLLATE "C"`;
        if (findOptions.orderBy !== undefined) {
          params.push(findOptions.orderBy);
          order = `data -> $${params.length}, ${order}`;
        }
        let limit = "";
        if (findOptions.limit !== undefined) {
          params.push(findOptions.limit);
          limit = `LIMIT $${params.length}`;
        }
        const read = await attempt(dependency, () =>
          sql.query<{ id: string; data: unknown }>(
            `SELECT id, data FROM ${s}.documents
             WHERE collection = $1 AND data @> $2::jsonb ${equalities.map((condition) => `AND ${condition}`).join(" ")}
             ORDER BY ${order} ${limit}`,
            params,
          ),
        );
        if (read.isErr()) return Result.err(read.error);
        return decodeAll(read.value.rows);
      },
    };
  };

  return { collection };
}
