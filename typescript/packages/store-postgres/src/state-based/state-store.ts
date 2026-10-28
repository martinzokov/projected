import {
  ConcurrencyConflict,
  Result,
  type DependencyUnavailable,
  type EventMetadata,
  type RecordedEvent,
  type SaveResult,
  type StateStore,
  type StoredState,
} from "@projected/application/state-based";
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

interface StateRow {
  version: number;
  schema_version: number | null;
  data: unknown;
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
 * written in the same transaction. Run `migrate()` first.
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
export function postgresStateStore(sql: SqlClient, options: PostgresOptions = {}): StateStore {
  const s = schemaOf(options);
  const dependency = "postgres state store";

  return {
    load: (key): Promise<Result<StoredState, DependencyUnavailable>> =>
      attempt(dependency, async () => {
        const { rows } = await sql.query<StateRow>(`SELECT version, schema_version, data FROM ${s}.states WHERE key = $1`, [key]);
        const row = rows[0];
        if (row === undefined) return { version: 0, state: undefined };
        return {
          version: row.version,
          state: row.schema_version === null ? undefined : { schemaVersion: row.schema_version, data: row.data },
        };
      }),

    save: async (key, write, { expectedVersion }) => {
      const saved = await attempt(dependency, () =>
        sql
          .transaction(async (tx): Promise<SaveResult> => {
            await tx.query(`INSERT INTO ${s}.states (key, version, event_count) VALUES ($1, 0, 0) ON CONFLICT (key) DO NOTHING`, [key]);
            const { rows } = await tx.query<{ version: number; event_count: number }>(
              `SELECT version, event_count FROM ${s}.states WHERE key = $1 FOR UPDATE`,
              [key],
            );
            const actual = rows[0]?.version ?? 0;
            const emitted = rows[0]?.event_count ?? 0;
            if (expectedVersion !== "any" && expectedVersion !== actual) throw new Conflict(actual);

            let recorded: RecordedEvent[] = [];
            if (write.events.length > 0) {
              await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`projected-outbox:${s}`]);
              const inserted = await tx.query<EventRow>(
                `INSERT INTO ${s}.outbox (event_id, stream, stream_version, type, schema_version, data, metadata)
                 SELECT coalesce(e.value ->> 'event_id', gen_random_uuid()::text), $1, $2 + e.ordinality,
                        e.value ->> 'type', (e.value ->> 'schema_version')::integer, e.value -> 'data', e.value -> 'metadata'
                 FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS e(value, ordinality)
                 ORDER BY e.ordinality
                 RETURNING ${COLUMNS}`,
                [
                  key,
                  emitted,
                  JSON.stringify(
                    write.events.map((event) => ({
                      event_id: event.eventId ?? null,
                      type: event.type,
                      schema_version: event.schemaVersion,
                      data: event.data,
                      metadata: event.metadata ?? {},
                    })),
                  ),
                ],
              );
              recorded = inserted.rows.map(toRecorded).sort((a, b) => a.streamVersion - b.streamVersion);
            }
            const version = actual + 1;
            await tx.query(
              `UPDATE ${s}.states
               SET version = $2, event_count = $3, schema_version = $4, data = $5::jsonb, updated_at = now()
               WHERE key = $1`,
              [
                key,
                version,
                emitted + write.events.length,
                write.state?.schemaVersion ?? null,
                write.state === null ? null : JSON.stringify(write.state.data),
              ],
            );
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
        const { rows } = await sql.query<EventRow>(
          `SELECT ${COLUMNS} FROM ${s}.outbox WHERE global_position > $1 ORDER BY global_position LIMIT $2`,
          [after, limit],
        );
        return rows.map(toRecorded);
      }),
  };
}
