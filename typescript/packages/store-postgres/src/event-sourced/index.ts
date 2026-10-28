/** PostgreSQL stores for event-sourced projects: the event store, plus every shared store. */
import { CORE_MIGRATIONS, runMigrations, type MigrationReport } from "../migrate.js";
import type { PostgresClient, PostgresOptions } from "../sql.js";
import { postgresCheckpointStore, postgresDocumentStore, postgresIdempotencyStore } from "../stores.js";
import { postgresEventStore } from "./event-store.js";
import { EVENT_SOURCED_MIGRATIONS } from "./migrations.js";

export * from "../index.js";
export { postgresEventStore } from "./event-store.js";

/**
 * Create or upgrade every table a event-sourced project needs. Safe to run on every start, from
 * several processes at once.
 */
export function migrate(db: PostgresClient, options: PostgresOptions = {}): Promise<MigrationReport> {
  return runMigrations(db, { core: CORE_MIGRATIONS, "event-sourced": EVENT_SOURCED_MIGRATIONS }, options);
}

/** Every Postgres-backed port, sharing one client and schema. */
export function postgresStores(db: PostgresClient, options: PostgresOptions = {}) {
  return {
    eventStore: postgresEventStore(db, options),
    checkpoints: postgresCheckpointStore(db, options),
    idempotency: postgresIdempotencyStore(db, options),
    documents: postgresDocumentStore(db, options),
  };
}
