/**
 * @projected/store-postgres — PostgreSQL adapters for every storage port. Infrastructure-only:
 * import it from `src/infrastructure/config`.
 *
 * This entry point holds what both flavours share: the client — Kysely over projected's typed
 * tables — and the checkpoint, idempotency and document stores. The tables' migrator and the
 * aggregate store come from the project's flavour, which also re-exports all of this:
 *
 * ```ts
 * import { fromPool, postgresMigrator, postgresStores } from "@projected/store-postgres/event-sourced";
 * import { prepareSchema } from "@projected/runtime";
 *
 * const db = fromPool(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
 * const schema = await prepareSchema([postgresMigrator(db)]); // or `projected migrate`, before rollout
 * if (schema.isErr()) throw schema.error;
 * const { eventStore, checkpoints, idempotency, documents } = postgresStores(db);
 * ```
 */
export { fromDialect, fromPool, schemaOf, type PostgresClient, type PostgresOptions } from "./sql.js";
export type { CoreTables, EventSourcedTables, EventTable, ProjectedDatabase, StateBasedTables } from "./database.js";
export { schemaMigrator, type Migration, type MigrationTracks, type SchemaMigratorOptions } from "./migrate.js";
export { postgresCheckpointStore, postgresDocumentStore, postgresIdempotencyStore } from "./stores.js";
export { postgresReadiness, type PostgresReadinessOptions } from "./readiness.js";
