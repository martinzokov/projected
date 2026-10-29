import {
  ConcurrencyConflict,
  Result,
  type AppendResult,
  type DependencyUnavailable,
  type EventStore,
  type RecordedEvent,
} from "@projected/application/event-sourced";
import type { Selectable } from "kysely";
import type { EventTable } from "../database.js";
import { COLUMNS, eventRow, toRecorded } from "../event-rows.js";
import { advisoryLock, attempt, inSchema, schemaOf, type PostgresClient, type PostgresOptions } from "../sql.js";

/** Raised inside the append transaction to roll it back; never escapes this module. */
class Conflict extends Error {
  readonly actual: number;
  constructor(actual: number) {
    super("conflict");
    this.actual = actual;
  }
}

/**
 * An {@link EventStore} on PostgreSQL. Its tables come from `postgresMigrator`.
 *
 * Concurrency: appends lock the stream's row (`SELECT ... FOR UPDATE`), so of two concurrent
 * appends at the same expected version exactly one wins.
 *
 * Ordering: `bigserial` values are handed out when rows are inserted but become visible when
 * transactions commit, which can be out of order — a reader at position 11 could later see 10
 * appear and miss it forever. Appends therefore take a transaction-scoped advisory lock just
 * before inserting events, so global positions become visible strictly in order. The lock is
 * held only for the insert and commit; it bounds append throughput to one transaction at a time
 * per schema: three round trips to the database (lock, insert, commit), so thousands per second
 * next to the database, and a few hundred where each round trip takes a millisecond.
 */
export function postgresEventStore(client: PostgresClient, options: PostgresOptions = {}): EventStore {
  const db = inSchema(client, options);
  const schema = schemaOf(options);
  const dependency = "postgres event store";

  return {
    readStream: (stream, readOptions = {}) =>
      attempt(dependency, async () => {
        const after = readOptions.after ?? 0;
        if (after === 0) {
          const rows = await db.selectFrom("events").select(COLUMNS).where("stream", "=", stream).orderBy("stream_version").execute();
          return { version: rows[rows.length - 1]?.stream_version ?? 0, events: rows.map(toRecorded) };
        }
        // One statement, so that the version and the events after `after` are of the same moment.
        const rows = await db
          .selectFrom("streams")
          .leftJoin("events", (join) => join.onRef("events.stream", "=", "streams.stream").on("events.stream_version", ">", after))
          .select(["streams.version as head", ...COLUMNS.map((column) => `events.${column}` as const)])
          .where("streams.stream", "=", stream)
          .orderBy("events.stream_version")
          .execute();
        const events = rows.flatMap((row) => (row.event_id === null ? [] : [toRecorded(row as Selectable<EventTable>)]));
        return { version: rows[0]?.head ?? 0, events };
      }),

    appendToStream: async (stream, events, { expectedVersion }) => {
      const appended = await attempt(dependency, () =>
        db
          .transaction()
          .execute(async (tx): Promise<AppendResult> => {
            await tx.insertInto("streams").values({ stream, version: 0 }).onConflict((conflict) => conflict.column("stream").doNothing()).execute();
            const row = await tx.selectFrom("streams").select("version").where("stream", "=", stream).forUpdate().executeTakeFirst();
            const actual = row?.version ?? 0;
            if (expectedVersion !== "any" && expectedVersion !== actual) throw new Conflict(actual);
            if (events.length === 0) return { version: actual, events: [] };

            const version = actual + events.length;
            // Before the ordering lock: the row is ours already, and the lock is held through commit,
            // so every statement taken out from under it is throughput for every writer.
            await tx.updateTable("streams").set({ version }).where("stream", "=", stream).execute();
            await advisoryLock(tx, "projected-append", schema);
            const inserted = await tx.insertInto("events").values(events.map(eventRow(stream, actual))).returning(COLUMNS).execute();
            const recorded = inserted.map(toRecorded).sort((a, b) => a.streamVersion - b.streamVersion);
            return { version, events: recorded };
          })
          .catch((error: unknown) => (error instanceof Conflict ? error : Promise.reject(error))),
      );
      if (appended.isErr()) return Result.err(appended.error);
      const value = appended.value;
      if (value instanceof Conflict) {
        return Result.err(
          new ConcurrencyConflict({
            key: stream,
            expectedVersion,
            actualVersion: value.actual,
            message: `Stream ${stream} is at version ${value.actual}, expected ${expectedVersion}`,
          }),
        );
      }
      return Result.ok(value);
    },

    readAll: ({ after, limit }): Promise<Result<readonly RecordedEvent[], DependencyUnavailable>> =>
      attempt(dependency, async () => {
        const rows = await db.selectFrom("events").select(COLUMNS).where("global_position", ">", String(after)).orderBy("global_position").limit(limit).execute();
        return rows.map(toRecorded);
      }),
  };
}
