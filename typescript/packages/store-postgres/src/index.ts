/**
 * @projected/store-postgres — PostgreSQL adapters for every storage port. Infrastructure-only:
 * import it from `src/infrastructure/config`.
 *
 * ```ts
 * const sql = fromPool(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
 * await migrate(sql);
 * const { eventStore, checkpoints, idempotency, documents } = postgresStores(sql);
 * ```
 */
import { postgresEventStore } from "./event-store.js";
import type { PostgresOptions, SqlClient } from "./sql.js";
import { postgresCheckpointStore, postgresDocumentStore, postgresIdempotencyStore } from "./stores.js";

export { fromPool, schemaOf, type PostgresOptions, type SqlClient } from "./sql.js";
export { migrate, type MigrationReport } from "./migrate.js";
export { postgresEventStore } from "./event-store.js";
export { postgresCheckpointStore, postgresDocumentStore, postgresIdempotencyStore } from "./stores.js";

/** Every Postgres-backed port, sharing one client and schema. */
export function postgresStores(sql: SqlClient, options: PostgresOptions = {}) {
  return {
    eventStore: postgresEventStore(sql, options),
    checkpoints: postgresCheckpointStore(sql, options),
    idempotency: postgresIdempotencyStore(sql, options),
    documents: postgresDocumentStore(sql, options),
  };
}
