import { betterAuthMigrator } from "@projected/auth-better-auth";
import { fromPool, postgresMigrator } from "@projected/store-postgres/event-sourced";
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";
import type { SchemaMigrator } from "@projected/application/event-sourced";
import { authOptions } from "./auth.js";

/**
 * Every set of tables the service keeps in PostgreSQL, in the order they are created: projected's,
 * then better-auth's. The service applies or checks them at start (see environment.ts), and
 * `projected migrate` applies them as a deploy step. An adapter with tables of its own adds a
 * `schemaMigrator(...)` here.
 */
export function migrators(pool: pg.Pool, env: NodeJS.ProcessEnv): SchemaMigrator[] {
  return [postgresMigrator(fromPool(pool)), betterAuthMigrator(() => getMigrations(authOptions(env, pool)))];
}

/** What `projected migrate` runs: the migrators over DATABASE_URL, and none without it. */
export function migrations(env: NodeJS.ProcessEnv = process.env) {
  const pool = env.DATABASE_URL === undefined ? undefined : new pg.Pool({ connectionString: env.DATABASE_URL });
  return {
    migrators: pool === undefined ? [] : migrators(pool, env),
    close: async () => {
      await pool?.end();
    },
  };
}
