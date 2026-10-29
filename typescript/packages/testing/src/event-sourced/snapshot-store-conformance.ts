import type { SnapshotStore } from "@projected/application/event-sourced";
import { describe, expect, it } from "vitest";

/**
 * The behaviour every {@link SnapshotStore} adapter must have. Run it from the adapter's test
 * suite: `snapshotStoreConformance("postgres", async () => postgresSnapshotStore(...))`.
 * `create` must return an empty store each time it is called.
 */
export function snapshotStoreConformance(name: string, create: () => SnapshotStore | Promise<SnapshotStore>): void {
  describe(`SnapshotStore conformance: ${name}`, () => {
    it("has no snapshot of a stream never snapshotted", async () => {
      const store = await create();

      expect((await store.load("account-1")).unwrap()).toBeUndefined();
    });

    it("returns the latest snapshot saved, as JSON", async () => {
      const store = await create();
      await store.save("account-1", { version: 100, schemaVersion: 1, state: { balance: 10 } });
      await store.save("account-1", { version: 200, schemaVersion: 1, state: { balance: 25, openedAt: new Date("2024-03-01T10:00:00.000Z") } });

      const loaded = (await store.load("account-1")).unwrap();

      expect(loaded).toEqual({ version: 200, schemaVersion: 1, state: { balance: 25, openedAt: "2024-03-01T10:00:00.000Z" } });
    });

    it("keeps a later snapshot when an earlier one arrives after it", async () => {
      const store = await create();
      await store.save("account-1", { version: 200, schemaVersion: 1, state: { balance: 25 } });

      await store.save("account-1", { version: 100, schemaVersion: 1, state: { balance: 10 } });

      expect((await store.load("account-1")).unwrap()?.version).toBe(200);
    });

    it("keeps streams apart", async () => {
      const store = await create();
      await store.save("account-1", { version: 100, schemaVersion: 1, state: { balance: 10 } });

      expect((await store.load("account-2")).unwrap()).toBeUndefined();
    });
  });
}
