import {
  ConcurrencyConflict,
  Result,
  type DependencyUnavailable,
  type RecordedEvent,
  type SaveResult,
  type StateStore,
  type StoredState,
} from "@projected/application/state-based";
import { sql } from "kysely";
import { COLUMNS, eventRow, toRecorded } from "../event-rows.js";
import { advisoryLock, attempt, inSchema, schemaOf, type PostgresClient, type PostgresOptions } from "../sql.js";

/** Rows deleted per statement when pruning, so that no statement holds locks for long. */
const PRUNE_BATCH = 5_000;

/** Raised inside the save transaction to roll it back; never escapes this module. */
class Conflict extends Error {
  readonly actual: number;
  constructor(actual: number) {
    super("conflict");
    this.actual = actual;
  }
}

/**
 * A {@link StateStore} on PostgreSQL: one `states` row per aggregate, and an `outbox` table
 * written in the same transaction. Its tables come from `postgresMigrator`.
 *
 * Concurrency: saves lock the aggregate's row (`SELECT ... FOR UPDATE`), so of two concurrent
 * saves at the same expected version exactly one wins. A removed aggregate keeps its row, with
 * no data, so its version keeps counting.
 *
 * Ordering: `bigserial` values are handed out when rows are inserted but become visible when
 * transactions commit, which can be out of order — a reader at position 11 could later see 10
 * appear and miss it forever. Saves that emit events therefore take a transaction-scoped
 * advisory lock just before inserting them, so outbox positions become visible strictly in
 * order. The lock is held only for the insert and commit; it bounds event-emitting saves to one
 * transaction at a time per schema, which is thousands per second for short transactions.
 */
export function postgresStateStore(client: PostgresClient, options: PostgresOptions = {}): StateStore {
  const db = inSchema(client, options);
  const schema = schemaOf(options);
  const dependency = "postgres state store";

  return {
    load: (key): Promise<Result<StoredState, DependencyUnavailable>> =>
      attempt(dependency, async () => {
        const row = await db.selectFrom("states").select(["version", "schema_version", "data"]).where("key", "=", key).executeTakeFirst();
        if (row === undefined) return { version: 0, state: undefined };
        return {
          version: row.version,
          state: row.schema_version === null ? undefined : { schemaVersion: row.schema_version, data: row.data },
        };
      }),

    save: async (key, write, { expectedVersion }) => {
      const saved = await attempt(dependency, () =>
        db
          .transaction()
          .execute(async (tx): Promise<SaveResult> => {
            await tx.insertInto("states").values({ key, version: 0, event_count: 0 }).onConflict((conflict) => conflict.column("key").doNothing()).execute();
            const row = await tx.selectFrom("states").select(["version", "event_count"]).where("key", "=", key).forUpdate().executeTakeFirst();
            const actual = row?.version ?? 0;
            const emitted = row?.event_count ?? 0;
            if (expectedVersion !== "any" && expectedVersion !== actual) throw new Conflict(actual);

            let recorded: RecordedEvent[] = [];
            if (write.events.length > 0) {
              await advisoryLock(tx, "projected-outbox", schema);
              const inserted = await tx.insertInto("outbox").values(write.events.map(eventRow(key, emitted))).returning(COLUMNS).execute();
              recorded = inserted.map(toRecorded).sort((a, b) => a.streamVersion - b.streamVersion);
            }
            const version = actual + 1;
            await tx
              .updateTable("states")
              .set({
                version,
                event_count: emitted + write.events.length,
                schema_version: write.state?.schemaVersion ?? null,
                data: write.state === null ? null : JSON.stringify(write.state.data),
                updated_at: sql<Date>`now()`,
              })
              .where("key", "=", key)
              .execute();
            return { version, events: recorded };
          })
          .catch((error: unknown) => (error instanceof Conflict ? error : Promise.reject(error))),
      );
      if (saved.isErr()) return Result.err(saved.error);
      const value = saved.value;
      if (value instanceof Conflict) {
        return Result.err(
          new ConcurrencyConflict({
            key,
            expectedVersion,
            actualVersion: value.actual,
            message: `${key} is at version ${value.actual}, expected ${expectedVersion}`,
          }),
        );
      }
      return Result.ok(value);
    },

    readAll: ({ after, limit }): Promise<Result<readonly RecordedEvent[], DependencyUnavailable>> =>
      attempt(dependency, async () => {
        const rows = await db.selectFrom("outbox").select(COLUMNS).where("global_position", ">", String(after)).orderBy("global_position").limit(limit).execute();
        return rows.map(toRecorded);
      }),

    pruneOutbox: ({ upTo, recordedBefore }) =>
      attempt(dependency, async () => {
        let pruned = 0;
        for (;;) {
          const deleted = await db
            .deleteFrom("outbox")
            .where("global_position", "in", (eb) =>
              eb
                .selectFrom("outbox")
                .select("global_position")
                .where("global_position", "<=", String(upTo))
                .where("recorded_at", "<", new Date(recordedBefore))
                .orderBy("global_position")
                .limit(PRUNE_BATCH),
            )
            .executeTakeFirst();
          const count = Number(deleted.numDeletedRows);
          pruned += count;
          if (count < PRUNE_BATCH) return pruned;
        }
      }),
  };
}
