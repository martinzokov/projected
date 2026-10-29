import { describe, expect, it } from "vitest";
import { DependencyUnavailable, Result, createApplication, defineContracts, defineEvent, defineEventHandler, z, type EventHandler } from "@projected/application/state-based";
import { inMemoryCheckpointStore, inMemoryStateStore } from "@projected/store-memory/state-based";
import { OUTBOX_RETENTION_MS, pruneOutbox, startOutboxPruning } from "@projected/runtime";
import { fixedClock, sequentialIds } from "@projected/testing/state-based";

const Pinged = defineEvent("Pinged", { schema: z.object({ n: z.number() }) });
const DAY = 24 * 60 * 60 * 1000;

const handler = (name: string) => defineEventHandler({ name, events: [Pinged], handle: { Pinged: () => Result.ok(undefined) } });

/** An outbox with a ping recorded on each of `days` days, read by `handlers`. */
async function pings(days: number, handlers: EventHandler[] = [handler("pings")]) {
  const clock = fixedClock("2024-03-01T10:00:00.000Z");
  const store = inMemoryStateStore({ clock });
  const app = createApplication(defineContracts({ name: "pings", access: "public" }), {
    ids: sequentialIds(),
    eventHandling: { handlers, store, checkpoints: inMemoryCheckpointStore(), inline: false },
  });
  for (let n = 1; n <= days; n++) {
    await store.save(`ping-${n}`, { state: { schemaVersion: 1, data: {} }, events: [Pinged.encode(Pinged({ n }))] }, { expectedVersion: 0 });
    clock.advance(DAY);
  }
  const left = () => store.all.map((event) => (event.data as { n: number }).n);
  return { app, store, clock, left };
}

describe("outbox pruning", () => {
  it("deletes the events every handler has passed once they are older than the retention", async () => {
    const { app, store, clock, left } = await pings(40);
    await app.catchUp();

    const pruned = await pruneOutbox(app, store, { clock });

    expect(pruned.unwrap()).toBe(10);
    expect(left()).toEqual(Array.from({ length: 30 }, (_, i) => i + 11));
  });

  it("keeps whatever the slowest handler has yet to process, however old", async () => {
    const stuck = defineEventHandler({
      name: "stuck",
      events: [Pinged],
      handle: { Pinged: ({ data }) => (data.n === 5 ? Result.err(new DependencyUnavailable({ dependency: "mailer", message: "down" })) : Result.ok(undefined)) },
    });
    const { app, store, clock, left } = await pings(40, [handler("fast"), stuck]);
    await app.catchUp();

    const pruned = await pruneOutbox(app, store, { clock, retentionMs: DAY });

    expect(pruned.unwrap()).toBe(4);
    expect(left()[0]).toBe(5);
  });

  it("prunes on the retention alone when nothing reads the outbox", async () => {
    const { app, store, clock, left } = await pings(3, []);

    const pruned = await pruneOutbox(app, store, { clock, retentionMs: 2 * DAY });

    expect(pruned.unwrap()).toBe(1);
    expect(left()).toEqual([2, 3]);
  });

  it("keeps thirty days of events by default", () => {
    expect(OUTBOX_RETENTION_MS).toBe(30 * DAY);
  });

  it("prunes in the background, reporting what it deleted and what failed", async () => {
    const { app, store, clock } = await pings(31);
    await app.catchUp();
    const reports: unknown[] = [];
    const failing = { pruneOutbox: async () => Result.err(new DependencyUnavailable({ dependency: "outbox", message: "down" })) };

    const pruner = startOutboxPruning(app, store, { clock, onPruned: (count) => reports.push(count) });
    const broken = startOutboxPruning(app, failing, { clock, onError: (error) => reports.push(error._tag) });
    await pruner.prune();
    await broken.prune();
    await Promise.all([pruner.stop(), broken.stop()]);

    expect(reports).toEqual([1, "DependencyUnavailable"]);
  });
});
