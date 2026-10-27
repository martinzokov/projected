import { Result, type Clock, type IdempotencyStore, type OperationResult } from "@projected/application";

type Entry =
  | { readonly status: "in-progress"; readonly fingerprint: string; readonly lockedUntil: number; readonly expiresAt: number }
  | { readonly status: "completed"; readonly fingerprint: string; readonly result: OperationResult; readonly expiresAt: number };

/** An {@link IdempotencyStore} in memory. Single-process only: use a shared store when you run several. */
export function inMemoryIdempotencyStore(options: { readonly clock?: Clock } = {}): IdempotencyStore {
  const now = () => (options.clock ?? { now: () => new Date() }).now().getTime();
  const entries = new Map<string, Entry>();

  return {
    claim: async (key, fingerprint, { lockMs, ttlMs }) => {
      const at = now();
      const entry = entries.get(key);
      const takeable =
        entry === undefined || entry.expiresAt <= at || (entry.status === "in-progress" && entry.lockedUntil <= at);
      if (takeable) {
        entries.set(key, { status: "in-progress", fingerprint, lockedUntil: at + lockMs, expiresAt: at + ttlMs });
        return Result.ok({ status: "claimed" });
      }
      return Result.ok(
        entry.status === "completed"
          ? { status: "completed", fingerprint: entry.fingerprint, result: structuredClone(entry.result) }
          : { status: "in-progress", fingerprint: entry.fingerprint },
      );
    },
    complete: async (key, result) => {
      const entry = entries.get(key);
      if (entry !== undefined) {
        entries.set(key, { status: "completed", fingerprint: entry.fingerprint, result: structuredClone(result), expiresAt: entry.expiresAt });
      }
      return Result.ok(undefined);
    },
    release: async (key) => {
      if (entries.get(key)?.status === "in-progress") entries.delete(key);
      return Result.ok(undefined);
    },
  };
}
