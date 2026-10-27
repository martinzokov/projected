import { describe, expect, it } from "vitest";
import { eventStoreConformance, fixedClock, sequentialIds } from "@projected/testing";
import { inMemoryCheckpointStore, inMemoryEventStore } from "@projected/event-store-memory";

eventStoreConformance("in-memory", () => inMemoryEventStore());

describe("inMemoryEventStore", () => {
  it("stamps events with the injected clock and ids", async () => {
    const store = inMemoryEventStore({ clock: fixedClock("2024-05-01T10:00:00.000Z"), ids: sequentialIds("evt") });

    await store.appendToStream("order-1", [{ type: "A", schemaVersion: 1, data: {} }], { expectedVersion: 0 });

    expect(store.all.map((e) => [e.eventId, e.recordedAt])).toEqual([["evt-1", "2024-05-01T10:00:00.000Z"]]);
  });
});

describe("inMemoryCheckpointStore", () => {
  it("starts at 0 and remembers saved positions", async () => {
    const checkpoints = inMemoryCheckpointStore();

    const before = (await checkpoints.load("p")).unwrap();
    await checkpoints.save("p", 7);

    expect([before, (await checkpoints.load("p")).unwrap()]).toEqual([0, 7]);
  });
});
