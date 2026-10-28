/**
 * @projected/store-postgres — PostgreSQL adapters for every storage port. Infrastructure-only:
 * import it from `src/infrastructure/config`.
 *
 * This entry point holds what both flavours share: the client, and the checkpoint, idempotency
 * and document stores. Migrations and the aggregate store come from the project's flavour, which
 * also re-exports all of this:
 *
 * ```ts
 * import { fromPool, migrate, postgresStores } from "@projected/store-postgres/event-sourced";
 *
 * const sql = fromPool(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
 * await migrate(sql);
 * const { eventStore, checkpoints, idempotency, documents } = postgresStores(sql);
 * ```
 */
export { fromPool, schemaOf, type PostgresOptions, type SqlClient } from "./sql.js";
export { runMigrations, type Migration, type MigrationReport, type MigrationTracks } from "./migrate.js";
export { postgresCheckpointStore, postgresDocumentStore, postgresIdempotencyStore } from "./stores.js";
