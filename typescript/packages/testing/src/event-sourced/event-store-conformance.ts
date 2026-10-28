import { ConcurrencyConflict, type EventStore, type NewEvent } from "@projected/application/event-sourced";
import { describe, expect, it } from "vitest";

const event = (type: string, data: unknown = {}): NewEvent => ({ type, schemaVersion: 1, data });

/**
 * The behaviour every {@link EventStore} adapter must have. Run it from the adapter's test suite:
 *
 * ```ts
 * eventStoreConformance("postgres", async () => postgresEventStore(await freshDatabase()));
 * ```
 *
 * `create` must return an empty store each time it is called.
 */
export function eventStoreConformance(name: string, create: () => EventStore | Promise<EventStore>): void {
  describe(`EventStore conformance: ${name}`, () => {
    it("reads a missing stream as empty at version 0", async () => {
      const store = await create();

      const slice = (await store.readStream("nothing-here")).unwrap();

      expect(slice).toEqual({ version: 0, events: [] });
    });

    it("appends to a new stream when expecting version 0", async () => {
      const store = await create();

      const appended = (await store.appendToStream("order-1", [event("A"), event("B")], { expectedVersion: 0 })).unwrap();

      expect(appended.version).toBe(2);
      expect(appended.events.map((e) => [e.type, e.streamVersion])).toEqual([
        ["A", 1],
        ["B", 2],
      ]);
    });

    it("returns events in append order with their data, metadata and schema version", async () => {
      const store = await create();
      await store.appendToStream(
        "order-1",
        [{ type: "A", schemaVersion: 3, data: { n: 1 }, metadata: { correlationId: "c-1" } }],
        { expectedVersion: 0 },
      );
      await store.appendToStream("order-1", [event("B", { n: 2 })], { expectedVersion: 1 });

      const { version, events } = (await store.readStream("order-1")).unwrap();

      expect(version).toBe(2);
      expect(events.map((e) => ({ type: e.type, data: e.data, v: e.schemaVersion }))).toEqual([
        { type: "A", data: { n: 1 }, v: 3 },
        { type: "B", data: { n: 2 }, v: 1 },
      ]);
      expect(events[0]?.metadata.correlationId).toBe("c-1");
      expect(events.every((e) => e.stream === "order-1" && e.eventId.length > 0)).toBe(true);
      expect(events.every((e) => !Number.isNaN(Date.parse(e.recordedAt)))).toBe(true);
    });

    it("keeps an event id supplied by the caller", async () => {
      const store = await create();

      const appended = (
        await store.appendToStream("order-1", [{ ...event("A"), eventId: "evt-42" }], { expectedVersion: 0 })
      ).unwrap();

      expect(appended.events[0]?.eventId).toBe("evt-42");
    });

    it("rejects an append when the stream moved on, and writes nothing", async () => {
      const store = await create();
      await store.appendToStream("order-1", [event("A")], { expectedVersion: 0 });

      const conflict = await store.appendToStream("order-1", [event("B")], { expectedVersion: 0 });

      expect(conflict.isErr() && ConcurrencyConflict.is(conflict.error)).toBe(true);
      expect(conflict.isErr() && conflict.error._tag === "ConcurrencyConflict" && conflict.error.actualVersion).toBe(1);
      expect((await store.readStream("order-1")).unwrap().version).toBe(1);
    });

    it("rejects creating a stream that already exists", async () => {
      const store = await create();
      await store.appendToStream("order-1", [event("A")], { expectedVersion: 0 });

      const conflict = await store.appendToStream("order-1", [event("A")], { expectedVersion: 0 });

      expect(conflict.isErr()).toBe(true);
    });

    it("appends regardless of version when expecting any", async () => {
      const store = await create();
      await store.appendToStream("order-1", [event("A")], { expectedVersion: "any" });

      const appended = (await store.appendToStream("order-1", [event("B")], { expectedVersion: "any" })).unwrap();

      expect(appended.version).toBe(2);
    });

    it("lets exactly one of two concurrent appends at the same version win", async () => {
      const store = await create();

      const outcomes = await Promise.all([
        store.appendToStream("order-1", [event("A")], { expectedVersion: 0 }),
        store.appendToStream("order-1", [event("B")], { expectedVersion: 0 }),
      ]);

      expect(outcomes.filter((o) => o.isOk())).toHaveLength(1);
      expect((await store.readStream("order-1")).unwrap().version).toBe(1);
    });

    it("keeps streams independent", async () => {
      const store = await create();
      await store.appendToStream("order-1", [event("A")], { expectedVersion: 0 });

      const other = (await store.appendToStream("order-2", [event("A")], { expectedVersion: 0 })).unwrap();

      expect(other.version).toBe(1);
    });

    it("reads the global log in order, after a position, up to a limit", async () => {
      const store = await create();
      await store.appendToStream("order-1", [event("A"), event("B")], { expectedVersion: 0 });
      await store.appendToStream("order-2", [event("C")], { expectedVersion: 0 });

      const all = (await store.readAll({ after: 0, limit: 10 })).unwrap();
      const rest = (await store.readAll({ after: all[0]?.globalPosition ?? 0, limit: 1 })).unwrap();

      expect(all.map((e) => e.type)).toEqual(["A", "B", "C"]);
      expect(all.every((e, i) => i === 0 || e.globalPosition > (all[i - 1]?.globalPosition ?? 0))).toBe(true);
      expect(rest.map((e) => e.type)).toEqual(["B"]);
    });

    it("does not let callers mutate stored events", async () => {
      const store = await create();
      const data = { items: ["a"] };
      await store.appendToStream("order-1", [event("A", data)], { expectedVersion: 0 });
      data.items.push("b");

      const { events } = (await store.readStream("order-1")).unwrap();

      expect(events[0]?.data).toEqual({ items: ["a"] });
    });
  });
}
