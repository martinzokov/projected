import { ConcurrencyConflict, type NewEvent, type SerializedState, type StateStore } from "@projected/application/state-based";
import { describe, expect, it } from "vitest";

const event = (type: string, data: unknown = {}): NewEvent => ({ type, schemaVersion: 1, data });
const state = (data: unknown, schemaVersion = 1): SerializedState => ({ schemaVersion, data });

/**
 * The behaviour every {@link StateStore} adapter must have. Run it from the adapter's test suite:
 *
 * ```ts
 * stateStoreConformance("postgres", async () => postgresStateStore(await freshDatabase()));
 * ```
 *
 * `create` must return an empty store each time it is called.
 */
export function stateStoreConformance(name: string, create: () => StateStore | Promise<StateStore>): void {
  describe(`StateStore conformance: ${name}`, () => {
    it("loads a missing aggregate as absent at version 0", async () => {
      const store = await create();

      const loaded = (await store.load("nothing-here")).unwrap();

      expect(loaded).toEqual({ version: 0, state: undefined });
    });

    it("saves a new aggregate when expecting version 0, recording its events", async () => {
      const store = await create();

      const saved = (
        await store.save("order-1", { state: state({ n: 1 }), events: [event("A"), event("B")] }, { expectedVersion: 0 })
      ).unwrap();

      expect(saved.version).toBe(1);
      expect(saved.events.map((e) => [e.type, e.stream, e.streamVersion])).toEqual([
        ["A", "order-1", 1],
        ["B", "order-1", 2],
      ]);
    });

    it("loads the latest saved state with its schema version", async () => {
      const store = await create();
      await store.save("order-1", { state: state({ n: 1 }), events: [] }, { expectedVersion: 0 });
      await store.save("order-1", { state: state({ n: 2, tags: ["x"] }, 3), events: [] }, { expectedVersion: 1 });

      const loaded = (await store.load("order-1")).unwrap();

      expect(loaded).toEqual({ version: 2, state: { schemaVersion: 3, data: { n: 2, tags: ["x"] } } });
    });

    it("records events with their data, metadata, schema version, id and time", async () => {
      const store = await create();

      await store.save(
        "order-1",
        { state: state({}), events: [{ type: "A", schemaVersion: 3, data: { n: 1 }, metadata: { correlationId: "c-1" } }] },
        { expectedVersion: 0 },
      );

      const [recorded] = (await store.readAll({ after: 0, limit: 10 })).unwrap();
      expect(recorded).toMatchObject({ type: "A", schemaVersion: 3, data: { n: 1 }, stream: "order-1" });
      expect(recorded?.metadata.correlationId).toBe("c-1");
      expect(recorded?.eventId.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(recorded?.recordedAt ?? ""))).toBe(false);
    });

    it("keeps an event id supplied by the caller", async () => {
      const store = await create();

      const saved = (
        await store.save("order-1", { state: state({}), events: [{ ...event("A"), eventId: "evt-42" }] }, { expectedVersion: 0 })
      ).unwrap();

      expect(saved.events[0]?.eventId).toBe("evt-42");
    });

    it("numbers an aggregate's events across saves", async () => {
      const store = await create();
      await store.save("order-1", { state: state({}), events: [event("A"), event("B")] }, { expectedVersion: 0 });
      await store.save("order-1", { state: state({}), events: [] }, { expectedVersion: 1 });

      const saved = (await store.save("order-1", { state: state({}), events: [event("C")] }, { expectedVersion: 2 })).unwrap();

      expect(saved.version).toBe(3);
      expect(saved.events.map((e) => e.streamVersion)).toEqual([3]);
    });

    it("rejects a save when the aggregate moved on, and writes neither state nor events", async () => {
      const store = await create();
      await store.save("order-1", { state: state({ n: 1 }), events: [event("A")] }, { expectedVersion: 0 });

      const conflict = await store.save("order-1", { state: state({ n: 2 }), events: [event("B")] }, { expectedVersion: 0 });

      expect(conflict.isErr() && ConcurrencyConflict.is(conflict.error)).toBe(true);
      expect(conflict.isErr() && conflict.error._tag === "ConcurrencyConflict" && conflict.error.actualVersion).toBe(1);
      expect((await store.load("order-1")).unwrap()).toEqual({ version: 1, state: state({ n: 1 }) });
      expect((await store.readAll({ after: 0, limit: 10 })).unwrap().map((e) => e.type)).toEqual(["A"]);
    });

    it("rejects creating an aggregate that already exists", async () => {
      const store = await create();
      await store.save("order-1", { state: state({}), events: [] }, { expectedVersion: 0 });

      const conflict = await store.save("order-1", { state: state({}), events: [] }, { expectedVersion: 0 });

      expect(conflict.isErr()).toBe(true);
    });

    it("saves regardless of version when expecting any", async () => {
      const store = await create();
      await store.save("order-1", { state: state({ n: 1 }), events: [] }, { expectedVersion: "any" });

      const saved = (await store.save("order-1", { state: state({ n: 2 }), events: [] }, { expectedVersion: "any" })).unwrap();

      expect(saved.version).toBe(2);
    });

    it("lets exactly one of two concurrent saves at the same version win", async () => {
      const store = await create();

      const outcomes = await Promise.all([
        store.save("order-1", { state: state({ by: "a" }), events: [event("A")] }, { expectedVersion: 0 }),
        store.save("order-1", { state: state({ by: "b" }), events: [event("B")] }, { expectedVersion: 0 }),
      ]);

      expect(outcomes.filter((o) => o.isOk())).toHaveLength(1);
      expect((await store.load("order-1")).unwrap().version).toBe(1);
      expect((await store.readAll({ after: 0, limit: 10 })).unwrap()).toHaveLength(1);
    });

    it("removes an aggregate but keeps its version, so stale writers still conflict", async () => {
      const store = await create();
      await store.save("order-1", { state: state({ n: 1 }), events: [] }, { expectedVersion: 0 });

      const removed = (await store.save("order-1", { state: null, events: [event("Removed")] }, { expectedVersion: 1 })).unwrap();
      const stale = await store.save("order-1", { state: state({ n: 2 }), events: [] }, { expectedVersion: 0 });

      expect(removed.version).toBe(2);
      expect((await store.load("order-1")).unwrap()).toEqual({ version: 2, state: undefined });
      expect(stale.isErr()).toBe(true);
    });

    it("can save an aggregate again after removing it", async () => {
      const store = await create();
      await store.save("order-1", { state: state({ n: 1 }), events: [] }, { expectedVersion: 0 });
      await store.save("order-1", { state: null, events: [] }, { expectedVersion: 1 });

      const saved = (await store.save("order-1", { state: state({ n: 3 }), events: [] }, { expectedVersion: 2 })).unwrap();

      expect(saved.version).toBe(3);
      expect((await store.load("order-1")).unwrap().state).toEqual(state({ n: 3 }));
    });

    it("keeps aggregates independent", async () => {
      const store = await create();
      await store.save("order-1", { state: state({}), events: [event("A")] }, { expectedVersion: 0 });

      const other = (await store.save("order-2", { state: state({}), events: [event("A")] }, { expectedVersion: 0 })).unwrap();

      expect(other.version).toBe(1);
      expect(other.events[0]?.streamVersion).toBe(1);
    });

    it("reads the outbox in order, after a position, up to a limit", async () => {
      const store = await create();
      await store.save("order-1", { state: state({}), events: [event("A"), event("B")] }, { expectedVersion: 0 });
      await store.save("order-2", { state: state({}), events: [event("C")] }, { expectedVersion: 0 });

      const all = (await store.readAll({ after: 0, limit: 10 })).unwrap();
      const rest = (await store.readAll({ after: all[0]?.globalPosition ?? 0, limit: 1 })).unwrap();

      expect(all.map((e) => e.type)).toEqual(["A", "B", "C"]);
      expect(all.every((e, i) => i === 0 || e.globalPosition > (all[i - 1]?.globalPosition ?? 0))).toBe(true);
      expect(rest.map((e) => e.type)).toEqual(["B"]);
    });

    it("does not let callers mutate stored states or events", async () => {
      const store = await create();
      const data = { items: ["a"] };
      await store.save("order-1", { state: state(data), events: [event("A", data)] }, { expectedVersion: 0 });
      data.items.push("b");

      const loaded = (await store.load("order-1")).unwrap();
      const events = (await store.readAll({ after: 0, limit: 10 })).unwrap();

      expect(loaded.state?.data).toEqual({ items: ["a"] });
      expect(events[0]?.data).toEqual({ items: ["a"] });
    });
  });
}
