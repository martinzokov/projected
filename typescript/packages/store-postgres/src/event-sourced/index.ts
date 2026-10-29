/** PostgreSQL stores for event-sourced projects: the event store, plus every shared store. */
import type { SchemaMigrator } from "@projected/application";
import { CORE_MIGRATIONS, tracksMigrator } from "../migrate.js";
import type { PostgresClient, PostgresOptions } from "../sql.js";
import { postgresCheckpointStore, postgresDocumentStore, postgresIdempotencyStore } from "../stores.js";
import { postgresEventStore } from "./event-store.js";
import { EVENT_SOURCED_MIGRATIONS } from "./migrations.js";
import { postgresSnapshotStore } from "./snapshots.js";

export * from "../index.js";
export { postgresEventStore } from "./event-store.js";
export { postgresSnapshotStore } from "./snapshots.js";

/**
 * Every table an event-sourced project needs, as one {@link SchemaMigrator} named `projected`.
 * List it in the service's migrations module, which `projected migrate` applies before a rollout
 * and the service checks (or applies) at start. Safe from several processes at once.
 */
export function postgresMigrator(db: PostgresClient, options: PostgresOptions = {}): SchemaMigrator {
  return tracksMigrator(db, { ...options, name: "projected", tracks: { core: CORE_MIGRATIONS, "event-sourced": EVENT_SOURCED_MIGRATIONS } });
}

/** Every Postgres-backed port, sharing one client and schema. */
export function postgresStores(db: PostgresClient, options: PostgresOptions = {}) {
  return {
    eventStore: postgresEventStore(db, options),
    snapshots: postgresSnapshotStore(db, options),
    checkpoints: postgresCheckpointStore(db, options),
    idempotency: postgresIdempotencyStore(db, options),
    documents: postgresDocumentStore(db, options),
  };
}
