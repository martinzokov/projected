import type { Result } from "@projected/domain";
import type { ConcurrencyConflict, DependencyUnavailable } from "../errors.js";
import type { EventLog, ExpectedVersion, NewEvent, RecordedEvent } from "../ports.js";

export interface StreamSlice {
  /** Number of events in the stream (0 when the stream does not exist). */
  readonly version: number;
  readonly events: readonly RecordedEvent[];
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
  readStream(stream: string): Promise<Result<StreamSlice, DependencyUnavailable>>;
  appendToStream(
    stream: string,
    events: readonly NewEvent[],
    options: { readonly expectedVersion: ExpectedVersion },
  ): Promise<Result<AppendResult, ConcurrencyConflict | DependencyUnavailable>>;
}

