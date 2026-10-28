import { sql } from "kysely";
import type { Migration } from "../migrate.js";

/**
 * The event store's tables: one row per stream for concurrency, and the events themselves.
 * Constraint names are the ones Postgres gave this migration's original SQL.
 */
export const EVENT_SOURCED_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: async (db) => {
      await db.schema
        .createTable("streams")
        .addColumn("stream", "text", (c) => c.primaryKey())
        .addColumn("version", "integer", (c) => c.notNull())
        .execute();
      await db.schema
        .createTable("events")
        .addColumn("global_position", "bigserial", (c) => c.primaryKey())
        .addColumn("event_id", "text", (c) => c.notNull().unique())
        .addColumn("stream", "text", (c) => c.notNull())
        .addColumn("stream_version", "integer", (c) => c.notNull())
        .addColumn("type", "text", (c) => c.notNull())
        .addColumn("schema_version", "integer", (c) => c.notNull())
        .addColumn("data", "jsonb", (c) => c.notNull())
        .addColumn("metadata", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'`))
        .addColumn("recorded_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
        .addUniqueConstraint("events_stream_stream_version_key", ["stream", "stream_version"])
        .execute();
    },
  },
];
