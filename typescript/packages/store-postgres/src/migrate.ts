import { sql, type Kysely } from "kysely";
import { advisoryLock, schemaOf, type PostgresClient, type PostgresOptions } from "./sql.js";

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
 * a service's own tables can be a track of their own.
 */
export type MigrationTracks = Readonly<Record<string, readonly Migration[]>>;

export interface MigrationReport {
  /** What this run applied, as `track@version`. */
  readonly applied: readonly string[];
  /** The latest version of each track. */
  readonly current: Readonly<Record<string, number>>;
}

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

/**
 * Create or upgrade the tables of the given tracks. Each migration runs once, in order, recorded
 * in `<schema>.migrations`. Safe to run on every start, from several processes at once: an
 * advisory lock makes concurrent migrators wait for each other.
 */
export async function runMigrations(db: PostgresClient, tracks: MigrationTracks, options: PostgresOptions = {}): Promise<MigrationReport> {
  const schema = schemaOf(options);
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
    const rows = await scoped.selectFrom("migrations").select(["track", "version"]).execute();
    const done = new Set(rows.map((row) => `${row.track}@${row.version}`));
    const applied: string[] = [];
    const current: Record<string, number> = {};
    for (const [track, migrations] of Object.entries(tracks)) {
      for (const migration of migrations) {
        const id = `${track}@${migration.version}`;
        if (done.has(id)) continue;
        await migration.up(scoped as unknown as Kysely<unknown>);
        await scoped.insertInto("migrations").values({ track, version: migration.version }).execute();
        applied.push(id);
      }
      current[track] = migrations[migrations.length - 1]?.version ?? 0;
    }
    return { applied, current };
  });
}
