/**
 * @projected/store-postgres — PostgreSQL adapters for every storage port. Infrastructure-only:
 * import it from `src/infrastructure/config`.
 *
 * This entry point holds what both flavours share: the client — Kysely over projected's typed
 * tables — and the checkpoint, idempotency and document stores. Migrations and the aggregate store come from the project's flavour, which
 * also re-exports all of this:
 *
 * ```ts
 * import { fromPool, migrate, postgresStores } from "@projected/store-postgres/event-sourced";
 *
 * const db = fromPool(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
 * await migrate(db);
 * const { eventStore, checkpoints, idempotency, documents } = postgresStores(db);
 * ```
 */
export { fromDialect, fromPool, schemaOf, type PostgresClient, type PostgresOptions } from "./sql.js";
export type { CoreTables, EventSourcedTables, EventTable, ProjectedDatabase, StateBasedTables } from "./database.js";
export { runMigrations, type Migration, type MigrationReport, type MigrationTracks } from "./migrate.js";
export { postgresCheckpointStore, postgresDocumentStore, postgresIdempotencyStore } from "./stores.js";
export { postgresReadiness, type PostgresReadinessOptions } from "./readiness.js";
