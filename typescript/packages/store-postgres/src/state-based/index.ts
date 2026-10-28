/** PostgreSQL stores for state-based projects: the state store and its outbox, plus every shared store. */
import { CORE_MIGRATIONS, runMigrations, type MigrationReport } from "../migrate.js";
import type { PostgresClient, PostgresOptions } from "../sql.js";
import { postgresCheckpointStore, postgresDocumentStore, postgresIdempotencyStore } from "../stores.js";
import { postgresStateStore } from "./state-store.js";
import { STATE_BASED_MIGRATIONS } from "./migrations.js";

export * from "../index.js";
export { postgresStateStore } from "./state-store.js";

/**
 * Create or upgrade every table a state-based project needs. Safe to run on every start, from
 * several processes at once.
 */
export function migrate(db: PostgresClient, options: PostgresOptions = {}): Promise<MigrationReport> {
  return runMigrations(db, { core: CORE_MIGRATIONS, "state-based": STATE_BASED_MIGRATIONS }, options);
}

/** Every Postgres-backed port, sharing one client and schema. */
export function postgresStores(db: PostgresClient, options: PostgresOptions = {}) {
  return {
    stateStore: postgresStateStore(db, options),
    checkpoints: postgresCheckpointStore(db, options),
    idempotency: postgresIdempotencyStore(db, options),
    documents: postgresDocumentStore(db, options),
  };
}
