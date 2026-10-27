import { Result, type CheckpointStore } from "@projected/application";

/** A {@link CheckpointStore} that keeps positions in memory. */
export function inMemoryCheckpointStore(): CheckpointStore {
  const positions = new Map<string, number>();
  return {
    load: async (name) => Result.ok(positions.get(name) ?? 0),
    save: async (name, position) => {
      positions.set(name, position);
      return Result.ok(undefined);
    },
  };
}
