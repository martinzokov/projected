import type { Result, SerializedState } from "@projected/domain/state-based";
import type { ConcurrencyConflict, DependencyUnavailable } from "../errors.js";
import type { EventLog, ExpectedVersion, NewEvent, RecordedEvent } from "../ports.js";

/** An aggregate as stored. */
export interface StoredState {
  /** Number of saves, removals included; 0 when the key has never been saved. */
  readonly version: number;
  /** Absent when the aggregate was never saved, or was removed. */
  readonly state: SerializedState | undefined;
}

/** What one save writes, atomically. */
export interface StateWrite {
  /**
   * The new state, or `null` to remove it. A removed aggregate keeps its version, so a writer
   * that loaded it before the removal still conflicts.
   */
  readonly state: SerializedState | null;
  /** Recorded in the store's outbox in the same transaction. */
  readonly events: readonly NewEvent[];
}

export interface SaveResult {
  /** The aggregate's version after the save. */
  readonly version: number;
  readonly events: readonly RecordedEvent[];
}

/** Which outbox events {@link StateStore.pruneOutbox} deletes: those matching both. */
export interface OutboxPruning {
  /** At or before this global position: the furthest every reader of the outbox has got. */
  readonly upTo: number;
  /** Recorded before this instant (ISO 8601), so that recent events stay for a replay. */
  readonly recordedBefore: string;
}

/**
 * The state store port: one document per aggregate, guarded by optimistic concurrency, and an
 * outbox — the events each save emits, written in the same transaction and readable in global
 * order, so that projections and relays never miss a change nor see one that was rolled back.
 * `@projected/testing` ships a conformance suite every adapter must pass.
 */
export interface StateStore extends EventLog {
  load(key: string): Promise<Result<StoredState, DependencyUnavailable>>;
  save(
    key: string,
    write: StateWrite,
    options: { readonly expectedVersion: ExpectedVersion },
  ): Promise<Result<SaveResult, ConcurrencyConflict | DependencyUnavailable>>;
  /**
   * Delete outbox events every reader has passed, once they are old enough: the state is the
   * record, so the outbox only has to hold events until they are delivered. Returns how many
   * were deleted. The events left keep their positions, and new ones never reuse a deleted one.
   */
  pruneOutbox(pruning: OutboxPruning): Promise<Result<number, DependencyUnavailable>>;
}
