import type { NewEvent, RecordedEvent } from "@projected/application";
import { sql, type Selectable } from "kysely";
import type { EventTable } from "./database.js";

/** How the event store's `events` and the state store's `outbox` turn into recorded events and back. */

export const toRecorded = (row: Selectable<EventTable>): RecordedEvent => ({
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

export const COLUMNS = ["global_position", "event_id", "stream", "stream_version", "type", "schema_version", "data", "metadata", "recorded_at"] as const;

/** An event as a row to insert, numbered after `after` in its stream; the store picks ids the caller left out. */
export const eventRow = (stream: string, after: number) => (event: NewEvent, index: number) => ({
  event_id: event.eventId ?? sql<string>`gen_random_uuid()::text`,
  stream,
  stream_version: after + index + 1,
  type: event.type,
  schema_version: event.schemaVersion,
  data: JSON.stringify(event.data),
  metadata: JSON.stringify(event.metadata ?? {}),
});
