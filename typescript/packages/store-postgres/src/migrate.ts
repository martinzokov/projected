import { schemaOf, type PostgresOptions, type SqlClient } from "./sql.js";

/**
 * Ordered, append-only schema migrations. Never edit a published entry: add a new one. Each runs
 * once, in a transaction, recorded in `<schema>.migrations`.
 */
const MIGRATIONS: ReadonlyArray<{ readonly version: number; readonly up: (schema: string) => string }> = [
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
      CREATE TABLE ${s}.checkpoints (
        name text PRIMARY KEY,
        position bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ${s}.idempotency (
        key text PRIMARY KEY,
        fingerprint text NOT NULL,
        status text NOT NULL CHECK (status IN ('in-progress', 'completed')),
        result jsonb,
        locked_until timestamptz NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX idempotency_expires_at ON ${s}.idempotency (expires_at);
      CREATE TABLE ${s}.documents (
        collection text NOT NULL,
        id text NOT NULL,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX documents_data ON ${s}.documents USING gin (data jsonb_path_ops);
    `,
  },
];

export interface MigrationReport {
  readonly applied: readonly number[];
  readonly current: number;
}

/**
 * Create or upgrade projected's tables. Safe to run on every start, from several processes at
 * once: an advisory lock makes concurrent migrators wait for each other.
 */
export async function migrate(sql: SqlClient, options: PostgresOptions = {}): Promise<MigrationReport> {
  const schema = schemaOf(options);
  return sql.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`projected-migrations:${schema}`]);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const { rows } = await tx.query<{ version: number }>(`SELECT version FROM ${schema}.migrations`);
    const done = new Set(rows.map((row) => row.version));
    const applied: number[] = [];
    for (const migration of MIGRATIONS) {
      if (done.has(migration.version)) continue;
      await tx.query(migration.up(schema));
      await tx.query(`INSERT INTO ${schema}.migrations (version) VALUES ($1)`, [migration.version]);
      applied.push(migration.version);
    }
    return { applied, current: MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0 };
  });
}
