import {
  ConcurrencyConflict,
  Result,
  type AppendResult,
  type DependencyUnavailable,
  type EventMetadata,
  type EventStore,
  type RecordedEvent,
} from "@projected/application/event-sourced";
import { attempt, schemaOf, type PostgresOptions, type SqlClient } from "../sql.js";

interface EventRow {
  global_position: string;
  event_id: string;
  stream: string;
  stream_version: number;
  type: string;
  schema_version: number;
  data: unknown;
  metadata: EventMetadata;
  recorded_at: Date;
}

const toRecorded = (row: EventRow): RecordedEvent => ({
  eventId: row.event_id,
  stream: row.stream,
  streamVersion: row.stream_version,
  globalPosition: Number(row.global_position),
  type: row.type,
  schemaVersion: row.schema_version,
  data: row.data,
  metadata: row.metadata,
  recordedAt: row.recorded_at.toISOString(),
});

const COLUMNS = "global_position, event_id, stream, stream_version, type, schema_version, data, metadata, recorded_at";

/** Raised inside the append transaction to roll it back; never escapes this module. */
class Conflict extends Error {
  readonly actual: number;
  constructor(actual: number) {
    super("conflict");
    this.actual = actual;
  }
}

/**
 * An {@link EventStore} on PostgreSQL. Run `migrate()` first.
 *
 * Concurrency: appends lock the stream's row (`SELECT ... FOR UPDATE`), so of two concurrent
 * appends at the same expected version exactly one wins.
 *
 * Ordering: `bigserial` values are handed out when rows are inserted but become visible when
 * transactions commit, which can be out of order — a reader at position 11 could later see 10
 * appear and miss it forever. Appends therefore take a transaction-scoped advisory lock just
 * before inserting events, so global positions become visible strictly in order. The lock is
 * held only for the insert and commit; it bounds append throughput to one transaction at a time
 * per schema, which is thousands per second for short transactions.
 */
export function postgresEventStore(sql: SqlClient, options: PostgresOptions = {}): EventStore {
  const s = schemaOf(options);
  const dependency = "postgres event store";

  return {
    readStream: (stream) =>
      attempt(dependency, async () => {
        const { rows } = await sql.query<EventRow>(
          `SELECT ${COLUMNS} FROM ${s}.events WHERE stream = $1 ORDER BY stream_version`,
          [stream],
        );
        return { version: rows[rows.length - 1]?.stream_version ?? 0, events: rows.map(toRecorded) };
      }),

    appendToStream: async (stream, events, { expectedVersion }) => {
      const appended = await attempt(dependency, () =>
        sql
          .transaction(async (tx): Promise<AppendResult> => {
            await tx.query(`INSERT INTO ${s}.streams (stream, version) VALUES ($1, 0) ON CONFLICT (stream) DO NOTHING`, [stream]);
            const { rows } = await tx.query<{ version: number }>(
              `SELECT version FROM ${s}.streams WHERE stream = $1 FOR UPDATE`,
              [stream],
            );
            const actual = rows[0]?.version ?? 0;
            if (expectedVersion !== "any" && expectedVersion !== actual) throw new Conflict(actual);
            if (events.length === 0) return { version: actual, events: [] };

            await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`projected-append:${s}`]);
            const inserted = await tx.query<EventRow>(
              `INSERT INTO ${s}.events (event_id, stream, stream_version, type, schema_version, data, metadata)
               SELECT coalesce(e.value ->> 'event_id', gen_random_uuid()::text), $1, $2 + e.ordinality,
                      e.value ->> 'type', (e.value ->> 'schema_version')::integer, e.value -> 'data', e.value -> 'metadata'
               FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS e(value, ordinality)
               ORDER BY e.ordinality
               RETURNING ${COLUMNS}`,
              [
                stream,
                actual,
                JSON.stringify(
                  events.map((event) => ({
                    event_id: event.eventId ?? null,
                    type: event.type,
                    schema_version: event.schemaVersion,
                    data: event.data,
                    metadata: event.metadata ?? {},
                  })),
                ),
              ],
            );
            const version = actual + events.length;
            await tx.query(`UPDATE ${s}.streams SET version = $2 WHERE stream = $1`, [stream, version]);
            const recorded = inserted.rows.map(toRecorded).sort((a, b) => a.streamVersion - b.streamVersion);
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
        const { rows } = await sql.query<EventRow>(
          `SELECT ${COLUMNS} FROM ${s}.events WHERE global_position > $1 ORDER BY global_position LIMIT $2`,
          [after, limit],
        );
        return rows.map(toRecorded);
      }),
  };
}
