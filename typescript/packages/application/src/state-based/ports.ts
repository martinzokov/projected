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
}
