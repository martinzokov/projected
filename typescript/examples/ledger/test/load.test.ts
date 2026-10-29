import { describe, expect, it } from "vitest";
import { inMemoryCheckpointStore, inMemoryDocumentStore, inMemoryEventStore, inMemoryIdempotencyStore, inMemorySnapshotStore } from "@projected/store-memory/event-sourced";
import { runLoad } from "./load/scenario.js";

/**
 * The load scenario at a small scale, so that it keeps working; `pnpm load` runs it at size.
 * Mutation testing leaves it out: it checks nothing the other tests do not, a hundred times slower.
 */
describe.skipIf(process.env["PROJECTED_MUTATION"] !== undefined)("the ledger under load", () => {
  it("carries out concurrent transfers over HTTP, conserving money and overdrawing no account", async () => {
    const report = await runLoad({
      stores: { eventStore: inMemoryEventStore(), snapshots: inMemorySnapshotStore(), checkpoints: inMemoryCheckpointStore(), documents: inMemoryDocumentStore(), idempotency: inMemoryIdempotencyStore() },
      accounts: 10,
      transfers: 300,
      concurrency: 20,
      openingBalance: 500_00,
    });

    expect(report.violations).toEqual([]);
    expect(report.completed + report.rejected).toBe(300);
    expect(report.rejected).toBeGreaterThan(0);
  }, 60_000);
});
