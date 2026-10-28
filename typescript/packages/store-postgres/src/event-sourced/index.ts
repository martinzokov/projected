/** PostgreSQL stores for event-sourced projects: the event store, plus every shared store. */
import { CORE_MIGRATIONS, runMigrations, type MigrationReport } from "../migrate.js";
import type { PostgresOptions, SqlClient } from "../sql.js";
import { postgresCheckpointStore, postgresDocumentStore, postgresIdempotencyStore } from "../stores.js";
import { postgresEventStore } from "./event-store.js";
import { EVENT_SOURCED_MIGRATIONS } from "./migrations.js";

export * from "../index.js";
export { postgresEventStore } from "./event-store.js";

/**
 * Create or upgrade every table a event-sourced project needs. Safe to run on every start, from
 * several processes at once.
 */
export function migrate(sql: SqlClient, options: PostgresOptions = {}): Promise<MigrationReport> {
  return runMigrations(sql, { core: CORE_MIGRATIONS, "event-sourced": EVENT_SOURCED_MIGRATIONS }, options);
}

/** Every Postgres-backed port, sharing one client and schema. */
export function postgresStores(sql: SqlClient, options: PostgresOptions = {}) {
  return {
    eventStore: postgresEventStore(sql, options),
    checkpoints: postgresCheckpointStore(sql, options),
    idempotency: postgresIdempotencyStore(sql, options),
    documents: postgresDocumentStore(sql, options),
  };
}
