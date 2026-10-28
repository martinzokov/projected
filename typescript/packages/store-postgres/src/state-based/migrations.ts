import type { Migration } from "../migrate.js";

/** The state store's tables: one row per aggregate, and the outbox written in the same transaction. */
export const STATE_BASED_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (s) => `
      CREATE TABLE ${s}.states (
        key text PRIMARY KEY,
        version integer NOT NULL,
        event_count integer NOT NULL,
        schema_version integer,
        data jsonb,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((schema_version IS NULL) = (data IS NULL))
      );
      CREATE TABLE ${s}.outbox (
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
