/** PostgreSQL stores for state-based projects: the state store and its outbox, plus every shared store. */
import type { SchemaMigrator } from "@projected/application";
import { CORE_MIGRATIONS, tracksMigrator } from "../migrate.js";
import type { PostgresClient, PostgresOptions } from "../sql.js";
import { postgresCheckpointStore, postgresDocumentStore, postgresIdempotencyStore } from "../stores.js";
import { postgresStateStore } from "./state-store.js";
import { STATE_BASED_MIGRATIONS } from "./migrations.js";

export * from "../index.js";
export { postgresStateStore } from "./state-store.js";

/**
 * Every table a state-based project needs, as one {@link SchemaMigrator} named `projected`.
 * List it in the service's migrations module, which `projected migrate` applies before a rollout
 * and the service checks (or applies) at start. Safe from several processes at once.
 */
export function postgresMigrator(db: PostgresClient, options: PostgresOptions = {}): SchemaMigrator {
  return tracksMigrator(db, { ...options, name: "projected", tracks: { core: CORE_MIGRATIONS, "state-based": STATE_BASED_MIGRATIONS } });
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
