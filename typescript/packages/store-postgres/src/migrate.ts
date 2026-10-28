import { panic, type SchemaMigrator } from "@projected/application";
import { sql, type Kysely } from "kysely";
import { advisoryLock, attempt, schemaOf, type PostgresClient, type PostgresOptions } from "./sql.js";

/**
 * One schema change. Never edit a published entry: add a new one. `up` gets the database scoped
 * to the project's schema — unqualified tables live there — and builds its change with Kysely's
 * schema builder (`db.schema.createTable(...)`), or `sql` for what the builder cannot say.
 */
export interface Migration {
  readonly version: number;
  readonly up: (db: Kysely<unknown>) => Promise<void>;
}

/**
 * Independent, ordered lists of migrations, keyed by track. Each flavour's tables are their own
 * track next to the shared `core` one, so the two flavours can never collide on a version number;
 * a service's own tables are a track of their own (any name but `core` and the flavours').
 */
export type MigrationTracks = Readonly<Record<string, readonly Migration[]>>;

const now = sql`now()`;

/**
 * Tables both flavours need: checkpoints, idempotency records and documents. Constraint names are
 * the ones Postgres gave this migration's original SQL, so every database has the same schema.
 */
export const CORE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: async (db) => {
      await db.schema
        .createTable("checkpoints")
        .addColumn("name", "text", (c) => c.primaryKey())
        .addColumn("position", "bigint", (c) => c.notNull())
        .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
        .execute();
      await db.schema
        .createTable("idempotency")
        .addColumn("key", "text", (c) => c.primaryKey())
        .addColumn("fingerprint", "text", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull().check(sql`status IN ('in-progress', 'completed')`))
        .addColumn("result", "jsonb")
        .addColumn("locked_until", "timestamptz", (c) => c.notNull())
        .addColumn("expires_at", "timestamptz", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("idempotency_expires_at").on("idempotency").column("expires_at").execute();
      await db.schema
        .createTable("documents")
        .addColumn("collection", "text", (c) => c.notNull())
        .addColumn("id", "text", (c) => c.notNull())
        .addColumn("data", "jsonb", (c) => c.notNull())
        .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
        .addPrimaryKeyConstraint("documents_pkey", ["collection", "id"])
        .execute();
      await db.schema.createIndex("documents_data").on("documents").using("gin").expression(sql`data jsonb_path_ops`).execute();
    },
  },
];

const id = (track: string, migration: Migration) => `${track}@${migration.version}`;

/** The migrations already applied in `schema`, as `track@version`; none before the first run. */
async function appliedIn(db: PostgresClient, schema: string): Promise<ReadonlySet<string>> {
  const table = await sql<{ found: string | null }>`SELECT to_regclass(${`"${schema}".migrations`})::text AS found`.execute(db);
  if (table.rows[0]?.found == null) return new Set();
  const rows = await db.withSchema(schema).selectFrom("migrations").select(["track", "version"]).execute();
  return new Set(rows.map((row) => `${row.track}@${row.version}`));
}

/** What {@link runMigrations} would apply, changing nothing (not even creating the schema). */
async function pendingMigrations(db: PostgresClient, tracks: MigrationTracks, schema: string): Promise<string[]> {
  const done = await appliedIn(db, schema);
  return Object.entries(tracks).flatMap(([track, migrations]) => migrations.map((migration) => id(track, migration)).filter((m) => !done.has(m)));
}

/**
 * Create or upgrade the tables of the given tracks, returning what was applied. Each migration
 * runs once, in order, recorded in `<schema>.migrations`, all in one transaction. Safe from
 * several processes at once: an advisory lock makes concurrent migrators wait for each other.
 */
async function runMigrations(db: PostgresClient, tracks: MigrationTracks, schema: string): Promise<string[]> {
  return db.transaction().execute(async (tx) => {
    await advisoryLock(tx, "projected-migrations", schema);
    await tx.schema.createSchema(schema).ifNotExists().execute();
    const scoped = tx.withSchema(schema);
    await scoped.schema
      .createTable("migrations")
      .ifNotExists()
      .addColumn("track", "text", (c) => c.notNull())
      .addColumn("version", "integer", (c) => c.notNull())
      .addColumn("applied_at", "timestamptz", (c) => c.notNull().defaultTo(now))
      .addPrimaryKeyConstraint("migrations_pkey", ["track", "version"])
      .execute();
    const done = await appliedIn(tx, schema);
    const applied: string[] = [];
    for (const [track, migrations] of Object.entries(tracks)) {
      for (const migration of migrations.filter((m) => !done.has(id(track, m)))) {
        await migration.up(scoped as unknown as Kysely<unknown>);
        await scoped.insertInto("migrations").values({ track, version: migration.version }).execute();
        applied.push(id(track, migration));
      }
    }
    return applied;
  });
}

export interface SchemaMigratorOptions extends PostgresOptions {
  /** Names the tables in reports and errors: `projected`, or the adapter that owns them. */
  readonly name: string;
  readonly tracks: MigrationTracks;
}

/** projected's own tracks: a service's tables taking one of these names would skip or clash with its migrations. */
const PROJECTED_TRACKS = ["core", "event-sourced", "state-based"];

/** A {@link SchemaMigrator} over migration tracks in the project's schema. */
export function tracksMigrator(db: PostgresClient, options: SchemaMigratorOptions): SchemaMigrator {
  const schema = schemaOf(options);
  const dependency = `postgres ${options.name} tables`;
  return {
    name: options.name,
    pending: () => attempt(dependency, () => pendingMigrations(db, options.tracks, schema)),
    apply: () => attempt(dependency, () => runMigrations(db, options.tracks, schema)),
  };
}

/**
 * A {@link SchemaMigrator} for a service's own tables — an adapter of its own that needs one —
 * kept in the project's schema and applied by `projected migrate` with projected's.
 */
export function schemaMigrator(db: PostgresClient, options: SchemaMigratorOptions): SchemaMigrator {
  const taken = Object.keys(options.tracks).filter((track) => PROJECTED_TRACKS.includes(track));
  if (taken.length > 0) panic(`Migration track "${taken[0]}" is projected's own: name the track after the tables it creates`);
  return tracksMigrator(db, options);
}
