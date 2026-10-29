import type { Result } from "@projected/domain";
import type { ConcurrencyConflict, DependencyUnavailable } from "../errors.js";
import type { EventLog, ExpectedVersion, NewEvent, RecordedEvent } from "../ports.js";

export interface StreamSlice {
  /** Number of events in the stream (0 when the stream does not exist), whatever was read. */
  readonly version: number;
  readonly events: readonly RecordedEvent[];
}

export interface ReadStreamOptions {
  /** Only the events after this stream version: those a snapshot taken there does not hold. */
  readonly after?: number;
}

export interface AppendResult {
  readonly version: number;
  readonly events: readonly RecordedEvent[];
}

/**
 * The event store port: append-only streams with optimistic concurrency, plus a global log
 * for projections and integrations. `@projected/testing` ships a conformance suite every adapter
 * must pass.
 */
export interface EventStore extends EventLog {
  readStream(stream: string, options?: ReadStreamOptions): Promise<Result<StreamSlice, DependencyUnavailable>>;
  appendToStream(
    stream: string,
    events: readonly NewEvent[],
    options: { readonly expectedVersion: ExpectedVersion },
  ): Promise<Result<AppendResult, ConcurrencyConflict | DependencyUnavailable>>;
}

/** An aggregate's state as of one version of its stream. */
export interface Snapshot {
  /** The stream version the state reflects: every event up to it is folded in. */
  readonly version: number;
  /** The aggregate's `snapshot.version` when it was taken. */
  readonly schemaVersion: number;
  /** The state, as JSON. */
  readonly state: unknown;
}

/**
 * Snapshots of event-sourced aggregates, one per stream. Disposable: losing them costs a longer
 * load, never data. `@projected/testing` ships a conformance suite every adapter must pass.
 */
export interface SnapshotStore {
  load(stream: string): Promise<Result<Snapshot | undefined, DependencyUnavailable>>;
  /** Keep `snapshot` unless the stream already has one taken at a later version. */
  save(stream: string, snapshot: Snapshot): Promise<Result<void, DependencyUnavailable>>;
}
