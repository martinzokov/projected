import {
  DependencyFailure,
  Result,
  type CheckpointStore,
  type DependencyUnavailable,
  type DocumentCollection,
  type DocumentStore,
  type IdempotencyClaim,
  type IdempotencyStore,
  type z,
} from "@projected/application";
import { sql } from "kysely";
import { attempt, inSchema, type PostgresClient, type PostgresOptions } from "./sql.js";

const now = sql<Date>`now()`;
/** `now()` plus `ms` milliseconds, in the database's clock. */
const inMs = (ms: number) => sql<Date>`now() + ${ms} * interval '1 millisecond'`;

/** A {@link CheckpointStore} on PostgreSQL. */
export function postgresCheckpointStore(client: PostgresClient, options: PostgresOptions = {}): CheckpointStore {
  const db = inSchema(client, options);
  const dependency = "postgres checkpoints";
  return {
    load: (name) =>
      attempt(dependency, async () => {
        const row = await db.selectFrom("checkpoints").select("position").where("name", "=", name).executeTakeFirst();
        return row === undefined ? 0 : Number(row.position);
      }),
    save: (name, position) =>
      attempt(dependency, async () => {
        await db
          .insertInto("checkpoints")
          .values({ name, position })
          .onConflict((conflict) => conflict.column("name").doUpdateSet((eb) => ({ position: eb.ref("excluded.position"), updated_at: now })))
          .execute();
      }),
  };
}

/**
 * An {@link IdempotencyStore} on PostgreSQL. Claims are one atomic upsert, so concurrent
 * requests with the same key — from any number of processes — get exactly one "claimed". Time
 * comes from the database, so application servers' clocks do not matter.
 */
export function postgresIdempotencyStore(client: PostgresClient, options: PostgresOptions = {}): IdempotencyStore & {
  /** Delete expired keys. Expired keys are already ignored; this only reclaims space — run it on a schedule. */
  purgeExpired(): Promise<Result<number, DependencyUnavailable>>;
} {
  const db = inSchema(client, options);
  const dependency = "postgres idempotency";

  const claimOnce = async (key: string, fingerprint: string, lockMs: number, ttlMs: number): Promise<IdempotencyClaim | undefined> => {
    // Insert, or take over a key whose outcome expired or whose claim was abandoned.
    const claimed = await db
      .insertInto("idempotency")
      .values({ key, fingerprint, status: "in-progress", result: null, locked_until: inMs(lockMs), expires_at: inMs(ttlMs) })
      .onConflict((conflict) =>
        conflict
          .column("key")
          .doUpdateSet((eb) => ({
            fingerprint: eb.ref("excluded.fingerprint"),
            status: "in-progress",
            result: null,
            locked_until: eb.ref("excluded.locked_until"),
            expires_at: eb.ref("excluded.expires_at"),
          }))
          .where((eb) =>
            eb.or([
              eb("idempotency.expires_at", "<=", now),
              eb.and([eb("idempotency.status", "=", "in-progress"), eb("idempotency.locked_until", "<=", now)]),
            ]),
          ),
      )
      .returning("key")
      .executeTakeFirst();
    if (claimed !== undefined) return { status: "claimed" };
    const row = await db.selectFrom("idempotency").select(["fingerprint", "status", "result"]).where("key", "=", key).executeTakeFirst();
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
        await db.updateTable("idempotency").set({ status: "completed", result: JSON.stringify(result) }).where("key", "=", key).execute();
      }),
    release: (key) =>
      attempt(dependency, async () => {
        await db.deleteFrom("idempotency").where("key", "=", key).where("status", "=", "in-progress").execute();
      }),
    purgeExpired: () =>
      attempt(dependency, async () => {
        const deleted = await db.deleteFrom("idempotency").where("expires_at", "<=", now).executeTakeFirst();
        return Number(deleted.numDeletedRows);
      }),
  };
}

/**
 * A {@link DocumentStore} on PostgreSQL: one JSONB table for every collection, indexed for
 * containment. Filters compare each field for exact equality; ordering follows JSONB's (numbers
 * numerically, strings by the database collation), ties broken by id.
 */
export function postgresDocumentStore(client: PostgresClient, options: PostgresOptions = {}): DocumentStore {
  const db = inSchema(client, options);

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
    const documents = db.selectFrom("documents").select(["id", "data"]).where("collection", "=", name);

    return {
      get: async (id) => {
        const read = await attempt(dependency, () => documents.where("id", "=", id).executeTakeFirst());
        if (read.isErr()) return Result.err(read.error);
        return read.value === undefined ? Result.ok(undefined) : decode(id, read.value.data);
      },
      put: (id, document) =>
        attempt(dependency, async () => {
          await db
            .insertInto("documents")
            .values({ collection: name, id, data: JSON.stringify(document) })
            .onConflict((conflict) => conflict.columns(["collection", "id"]).doUpdateSet((eb) => ({ data: eb.ref("excluded.data"), updated_at: now })))
            .execute();
        }),
      delete: (id) =>
        attempt(dependency, async () => {
          await db.deleteFrom("documents").where("collection", "=", name).where("id", "=", id).execute();
        }),
      find: async (filter, findOptions = {}) => {
        // Containment uses the GIN index; the equalities make it exact for nested values.
        let query = documents.where(sql<boolean>`data @> ${JSON.stringify(filter)}::jsonb`);
        for (const [field, value] of Object.entries(filter)) {
          query = query.where(sql<boolean>`data -> ${field} = ${JSON.stringify(value)}::jsonb`);
        }
        if (findOptions.orderBy !== undefined) query = query.orderBy(sql`data -> ${findOptions.orderBy}`);
        query = query.orderBy(sql`id COLLATE "C"`);
        if (findOptions.limit !== undefined) query = query.limit(findOptions.limit);
        const read = await attempt(dependency, () => query.execute());
        if (read.isErr()) return Result.err(read.error);
        return decodeAll(read.value);
      },
    };
  };

  return { collection };
}
