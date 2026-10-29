import type { SnapshotStore } from "@projected/application/event-sourced";
import { sql } from "kysely";
import { attempt, inSchema, type PostgresClient, type PostgresOptions } from "../sql.js";

/**
 * A {@link SnapshotStore} on PostgreSQL: the latest snapshot of each stream, one row per stream.
 * A save replaces the row only with a later version, so a slow writer never puts an older
 * snapshot back.
 */
export function postgresSnapshotStore(client: PostgresClient, options: PostgresOptions = {}): SnapshotStore {
  const db = inSchema(client, options);
  const dependency = "postgres snapshots";
  return {
    load: (stream) =>
      attempt(dependency, async () => {
        const row = await db.selectFrom("snapshots").select(["version", "schema_version", "state"]).where("stream", "=", stream).executeTakeFirst();
        return row === undefined ? undefined : { version: row.version, schemaVersion: row.schema_version, state: row.state };
      }),
    save: (stream, snapshot) =>
      attempt(dependency, async () => {
        await db
          .insertInto("snapshots")
          .values({ stream, version: snapshot.version, schema_version: snapshot.schemaVersion, state: JSON.stringify(snapshot.state) })
          .onConflict((conflict) =>
            conflict
              .column("stream")
              .doUpdateSet((eb) => ({
                version: eb.ref("excluded.version"),
                schema_version: eb.ref("excluded.schema_version"),
                state: eb.ref("excluded.state"),
                taken_at: sql<Date>`now()`,
              }))
              .where("snapshots.version", "<", (eb) => eb.ref("excluded.version")),
          )
          .execute();
      }),
  };
}
