import { fromPool, postgresMigrator } from "@projected/store-postgres/event-sourced";
import pg from "pg";
import type { SchemaMigrator } from "@projected/application/event-sourced";

/**
 * Every set of tables the service keeps in PostgreSQL: projected's. The service applies or
 * checks them at start (see environment.ts), and `projected migrate` applies them as a deploy
 * step. An adapter with tables of its own adds a `schemaMigrator(...)` here.
 */
export function migrators(pool: pg.Pool): SchemaMigrator[] {
  return [postgresMigrator(fromPool(pool))];
}

/** What `projected migrate` runs: the migrators over DATABASE_URL, and none without it. */
export function migrations(env: NodeJS.ProcessEnv = process.env) {
  const pool = env.DATABASE_URL === undefined ? undefined : new pg.Pool({ connectionString: env.DATABASE_URL });
  return {
    migrators: pool === undefined ? [] : migrators(pool),
    close: async () => {
      await pool?.end();
    },
  };
}
