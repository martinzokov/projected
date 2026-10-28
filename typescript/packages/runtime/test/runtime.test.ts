import { describe, expect, it } from "vitest";
import { createApplication, defineContracts, defineEvent, defineEventHandler, Result, z } from "@projected/application/event-sourced";
import { inMemoryCheckpointStore, inMemoryEventStore } from "@projected/store-memory/event-sourced";
import { randomIds, startPolling, systemClock } from "@projected/runtime";
import { sequentialIds } from "@projected/testing/event-sourced";

const Pinged = defineEvent("Pinged", { schema: z.object({ n: z.number() }) });

describe("runtime", () => {
  it("generates distinct ids and real timestamps", () => {
    const ids = randomIds();

    expect(ids.next()).not.toBe(ids.next());
    expect(Math.abs(systemClock().now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it("polls event handlers in the background until stopped", async () => {
    const store = inMemoryEventStore();
    const seen: number[] = [];
    let resolveSeen: () => void = () => {};
    const done = new Promise<void>((resolve) => (resolveSeen = resolve));
    const handler = defineEventHandler({
      name: "pings",
      events: [Pinged],
      handle: {
        Pinged: ({ data }) => {
          seen.push(data.n);
          if (seen.length === 2) resolveSeen();
          return Result.ok(undefined);
        },
      },
    });
    const app = createApplication(defineContracts({ name: "pings", access: "public" }), {
      ids: sequentialIds(),
      eventHandling: { handlers: [handler], store, checkpoints: inMemoryCheckpointStore(), inline: false },
    });
    const poller = startPolling(app, { intervalMs: 5 });

    await store.appendToStream("ping-1", [Pinged.encode(Pinged({ n: 1 })), Pinged.encode(Pinged({ n: 2 }))], {
      expectedVersion: 0,
    });
    await done;
    await poller.stop();

    expect(seen).toEqual([1, 2]);
  });
});
