import { schemaOf, type PostgresOptions, type SqlClient } from "./sql.js";

/** One schema change. Never edit a published entry: add a new one. */
export interface Migration {
  readonly version: number;
  readonly up: (schema: string) => string;
}

/**
 * Independent, ordered lists of migrations, keyed by track. Each flavour's tables are their own
 * track next to the shared `core` one, so the two flavours can never collide on a version number.
 */
export type MigrationTracks = Readonly<Record<string, readonly Migration[]>>;

export interface MigrationReport {
  /** What this run applied, as `track@version`. */
  readonly applied: readonly string[];
  /** The latest version of each track. */
  readonly current: Readonly<Record<string, number>>;
}

/** Tables both flavours need: checkpoints, idempotency records and documents. */
export const CORE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (s) => `
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

/**
 * Create or upgrade the tables of the given tracks. Each migration runs once, in order, recorded
 * in `<schema>.migrations`. Safe to run on every start, from several processes at once: an
 * advisory lock makes concurrent migrators wait for each other.
 */
export async function runMigrations(
  sql: SqlClient,
  tracks: MigrationTracks,
  options: PostgresOptions = {},
): Promise<MigrationReport> {
  const schema = schemaOf(options);
  return sql.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`projected-migrations:${schema}`]);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.migrations (
         track text NOT NULL,
         version integer NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (track, version)
       )`,
    );
    const { rows } = await tx.query<{ track: string; version: number }>(`SELECT track, version FROM ${schema}.migrations`);
    const done = new Set(rows.map((row) => `${row.track}@${row.version}`));
    const applied: string[] = [];
    const current: Record<string, number> = {};
    for (const [track, migrations] of Object.entries(tracks)) {
      for (const migration of migrations) {
        const id = `${track}@${migration.version}`;
        if (done.has(id)) continue;
        await tx.query(migration.up(schema));
        await tx.query(`INSERT INTO ${schema}.migrations (track, version) VALUES ($1, $2)`, [track, migration.version]);
        applied.push(id);
      }
      current[track] = migrations[migrations.length - 1]?.version ?? 0;
    }
    return { applied, current };
  });
}
