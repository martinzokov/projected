import { inMemoryCheckpointStore, inMemoryDocumentStore, inMemoryEventStore, inMemoryIdempotencyStore, inMemorySnapshotStore } from "@projected/store-memory/event-sourced";
import { fromPool, postgresReadiness, postgresStores } from "@projected/store-postgres/event-sourced";
import { prepareSchema } from "@projected/runtime";
import pg from "pg";
import type { Clock } from "@projected/application/event-sourced";
import { migrators } from "./migrations.js";

/**
 * Picks real infrastructure from the environment, and in-memory stand-ins otherwise, so the
 * service runs with `pnpm start` alone and against PostgreSQL when configured:
 *
 *   DATABASE_URL      PostgreSQL for events, snapshots, checkpoints, idempotency and read models
 *   DATABASE_POOL     connections in the pool (default 20)
 *   MIGRATE_ON_START  "false" where `projected migrate` runs before each rollout: the service
 *                     then only checks that its tables are current, and refuses to start if not
 */
export async function environment(clock: Clock, env: NodeJS.ProcessEnv = process.env) {
  const pool = env.DATABASE_URL === undefined ? undefined : new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.DATABASE_POOL ?? 20) });
  const db = pool === undefined ? undefined : fromPool(pool);
  if (pool !== undefined) {
    const schema = await prepareSchema(migrators(pool), { apply: env.MIGRATE_ON_START !== "false" });
    if (schema.isErr()) throw schema.error;
  }
  const stores =
    db === undefined
      ? {
          eventStore: inMemoryEventStore({ clock }),
          snapshots: inMemorySnapshotStore(),
          checkpoints: inMemoryCheckpointStore(),
          idempotency: inMemoryIdempotencyStore({ clock }),
          documents: inMemoryDocumentStore(),
        }
      : postgresStores(db);

  return {
    ...stores,
    // Not ready while the database is unreachable.
    readiness: db === undefined ? [] : [postgresReadiness(db)],
    close: async () => {
      await pool?.end();
    },
  };
}
