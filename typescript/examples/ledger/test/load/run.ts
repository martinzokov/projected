/**
 * The ledger under load: `pnpm load`, in memory, or against PostgreSQL with DATABASE_URL (in a
 * schema of its own, dropped afterwards). It fails if any of the ledger's invariants broke.
 *
 *   ACCOUNTS     customers, each with an account (default 200)
 *   TRANSFERS    transfers requested (default 5000)
 *   CONCURRENCY  requests in flight at once (default 50)
 */
import { inMemoryCheckpointStore, inMemoryDocumentStore, inMemoryEventStore, inMemoryIdempotencyStore, inMemorySnapshotStore } from "@projected/store-memory/event-sourced";
import { fromPool, postgresMigrator, postgresStores } from "@projected/store-postgres/event-sourced";
import pg from "pg";
import { expect, it } from "vitest";
import { runLoad, type LoadOptions } from "./scenario.js";

const setting = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const ms = (value: number) => `${value.toFixed(1)} ms`;

it("keeps every invariant of a ledger under load", async () => {
  const url = process.env["DATABASE_URL"];
  const pool = url === undefined ? undefined : new pg.Pool({ connectionString: url, max: setting("DATABASE_POOL", 20) });
  const schema = `ledger_load_${Date.now()}`;
  let stores: LoadOptions["stores"];
  if (pool === undefined) {
    stores = { eventStore: inMemoryEventStore(), snapshots: inMemorySnapshotStore(), checkpoints: inMemoryCheckpointStore(), documents: inMemoryDocumentStore(), idempotency: inMemoryIdempotencyStore() };
  } else {
    (await postgresMigrator(fromPool(pool), { schema }).apply()).unwrap();
    stores = postgresStores(fromPool(pool), { schema });
  }

  try {
    const report = await runLoad({
      stores,
      accounts: setting("ACCOUNTS", 200),
      transfers: setting("TRANSFERS", 5000),
      concurrency: setting("CONCURRENCY", 50),
      onProgress: (line) => console.log(line),
    });

    console.log(
      [
        `ledger load, ${pool === undefined ? "in memory" : "PostgreSQL"}`,
        `  transfers    ${report.transfers}: ${report.completed} completed, ${report.rejected} rejected`,
        `  requested    ${report.requestsPerSecond.toFixed(0)}/s; p50 ${ms(report.latency.p50)}, p95 ${ms(report.latency.p95)}, p99 ${ms(report.latency.p99)}, max ${ms(report.latency.max)}`,
        `  carried out  ${report.settledPerSecond.toFixed(0)}/s, end to end`,
        `  invariants   ${report.violations.length === 0 ? "all held" : report.violations.join("; ")}`,
      ].join("\n"),
    );
    expect(report.violations).toEqual([]);
  } finally {
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.end();
  }
});
