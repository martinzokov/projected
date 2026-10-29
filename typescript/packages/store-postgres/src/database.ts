import type { EventMetadata, OperationResult } from "@projected/application";
import type { ColumnType, Generated } from "kysely";

/**
 * projected's tables, as the queries see them: every column a query names is checked against
 * these at compile time. They describe what the migrations create — change both together.
 */

/** jsonb: read as parsed JSON, written as JSON text — node-postgres would send a JS array as a Postgres array. */
type Json<Read, Write = string> = ColumnType<Read, Write, Write>;
/** bigint and bigserial: node-postgres reads them as strings, so no value loses precision. */
type BigInt = ColumnType<string, number | string, number | string>;

export interface CoreTables {
  migrations: { track: string; version: number; applied_at: Generated<Date> };
  checkpoints: { name: string; position: BigInt; updated_at: Generated<Date> };
  idempotency: {
    key: string;
    fingerprint: string;
    status: "in-progress" | "completed";
    result: Json<OperationResult | null, string | null>;
    locked_until: Date;
    expires_at: Date;
  };
  documents: { collection: string; id: string; data: Json<unknown>; updated_at: Generated<Date> };
}

/** An event as stored: in the event store's `events`, or the state store's `outbox`. */
export interface EventTable {
  global_position: ColumnType<string, never, never>;
  event_id: string;
  stream: string;
  stream_version: number;
  type: string;
  schema_version: number;
  data: Json<unknown>;
  metadata: ColumnType<EventMetadata, string | undefined, string>;
  recorded_at: Generated<Date>;
}

export interface EventSourcedTables {
  streams: { stream: string; version: number };
  events: EventTable;
  snapshots: { stream: string; version: number; schema_version: number; state: Json<unknown>; taken_at: Generated<Date> };
}

export interface StateBasedTables {
  states: {
    key: string;
    version: number;
    event_count: number;
    schema_version: number | null;
    data: Json<unknown, string | null>;
    updated_at: Generated<Date>;
  };
  outbox: EventTable;
}

export type ProjectedDatabase = CoreTables & EventSourcedTables & StateBasedTables;
