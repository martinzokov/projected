import { describe, expect, it } from "vitest";
import {
  checkpointStoreConformance,
  documentStoreConformance,
  eventStoreConformance,
  fixedClock,
  idempotencyStoreConformance,
  sequentialIds,
  snapshotStoreConformance,
} from "@projected/testing/event-sourced";
import {
  inMemoryCheckpointStore,
  inMemoryDocumentStore,
  inMemoryEventStore,
  inMemoryIdempotencyStore,
  inMemorySnapshotStore,
} from "@projected/store-memory/event-sourced";
import { inMemoryStateStore } from "@projected/store-memory/state-based";
import { stateStoreConformance } from "@projected/testing/state-based";

eventStoreConformance("in-memory", () => inMemoryEventStore());
stateStoreConformance("in-memory", () => inMemoryStateStore());
checkpointStoreConformance("in-memory", () => inMemoryCheckpointStore());
idempotencyStoreConformance("in-memory", () => inMemoryIdempotencyStore());
documentStoreConformance("in-memory", () => inMemoryDocumentStore());
snapshotStoreConformance("in-memory", () => inMemorySnapshotStore());

describe("inMemoryEventStore", () => {
  it("stamps events with the injected clock and ids", async () => {
    const store = inMemoryEventStore({ clock: fixedClock("2024-05-01T10:00:00.000Z"), ids: sequentialIds("evt") });

    await store.appendToStream("order-1", [{ type: "A", schemaVersion: 1, data: {} }], { expectedVersion: 0 });

    expect(store.all.map((e) => [e.eventId, e.recordedAt])).toEqual([["evt-1", "2024-05-01T10:00:00.000Z"]]);
  });
});

describe("inMemoryStateStore", () => {
  it("stamps outbox events with the injected clock and ids", async () => {
    const store = inMemoryStateStore({ clock: fixedClock("2024-05-01T10:00:00.000Z"), ids: sequentialIds("evt") });

    await store.save(
      "order-1",
      { state: { schemaVersion: 1, data: {} }, events: [{ type: "A", schemaVersion: 1, data: {} }] },
      { expectedVersion: 0 },
    );

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
