import { Result, type Snapshot, type SnapshotStore } from "@projected/application/event-sourced";
import { asJson } from "../json.js";

/** A {@link SnapshotStore} that keeps the latest snapshot of each stream in memory. */
export function inMemorySnapshotStore(): SnapshotStore {
  const snapshots = new Map<string, Snapshot>();
  return {
    load: async (stream) => Result.ok(asJson(snapshots.get(stream))),
    save: async (stream, snapshot) => {
      const current = snapshots.get(stream);
      if (current === undefined || current.version < snapshot.version) snapshots.set(stream, asJson(snapshot));
      return Result.ok(undefined);
    },
  };
}
