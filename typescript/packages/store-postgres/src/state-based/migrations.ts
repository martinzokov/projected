import { sql } from "kysely";
import type { Migration } from "../migrate.js";

/**
 * The state store's tables: one row per aggregate, and the outbox written in the same
 * transaction. Constraint names are the ones Postgres gave this migration's original SQL.
 */
export const STATE_BASED_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: async (db) => {
      await db.schema
        .createTable("states")
        .addColumn("key", "text", (c) => c.primaryKey())
        .addColumn("version", "integer", (c) => c.notNull())
        .addColumn("event_count", "integer", (c) => c.notNull())
        .addColumn("schema_version", "integer")
        .addColumn("data", "jsonb")
        .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("states_check", sql`(schema_version IS NULL) = (data IS NULL)`)
        .execute();
      await db.schema
        .createTable("outbox")
        .addColumn("global_position", "bigserial", (c) => c.primaryKey())
        .addColumn("event_id", "text", (c) => c.notNull().unique())
        .addColumn("stream", "text", (c) => c.notNull())
        .addColumn("stream_version", "integer", (c) => c.notNull())
        .addColumn("type", "text", (c) => c.notNull())
        .addColumn("schema_version", "integer", (c) => c.notNull())
        .addColumn("data", "jsonb", (c) => c.notNull())
        .addColumn("metadata", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'`))
        .addColumn("recorded_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
        .addUniqueConstraint("outbox_stream_stream_version_key", ["stream", "stream_version"])
        .execute();
    },
  },
];
