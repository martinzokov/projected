import type { Migration } from "../migrate.js";

/** The event store's tables: one row per stream for concurrency, and the events themselves. */
export const EVENT_SOURCED_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (s) => `
      CREATE TABLE ${s}.streams (
        stream text PRIMARY KEY,
        version integer NOT NULL
      );
      CREATE TABLE ${s}.events (
        global_position bigserial PRIMARY KEY,
        event_id text NOT NULL UNIQUE,
        stream text NOT NULL,
        stream_version integer NOT NULL,
        type text NOT NULL,
        schema_version integer NOT NULL,
        data jsonb NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}',
        recorded_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (stream, stream_version)
      );
    `,
  },
];
