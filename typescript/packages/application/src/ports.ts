import type { Result } from "@projected/domain";
import type { ConcurrencyConflict, DependencyUnavailable } from "./errors.js";

/**
 * Driven ports the framework itself needs. Adapters live in infrastructure packages
 * (`@projected/event-store-memory`, `@projected/runtime`, ...); use cases only see these interfaces.
 */

/** Identifies one message (HTTP request, queued command, event) and the flow it belongs to. */
export interface Metadata {
  /** Unique id of the incoming message. */
  readonly messageId: string;
  /** Shared by every message in one business flow. Defaults to the first message's id. */
  readonly correlationId: string;
  /** Id of the message that caused this one, if any. */
  readonly causationId: string | undefined;
  /** Caller-supplied key for safe retries of the same command. */
  readonly idempotencyKey: string | undefined;
}

/** Passed to every handler. Forward it to ports so correlation flows through the system. */
export interface ExecutionContext {
  readonly metadata: Metadata;
}

/** The current time. Inject it instead of calling `Date.now()` so that logic stays deterministic. */
export interface Clock {
  now(): Date;
}

/** New unique identifiers. Inject it instead of calling `crypto.randomUUID()`. */
export interface IdGenerator {
  next(): string;
}

/** Expected stream version for optimistic concurrency: an exact version (0 = no stream yet) or `"any"`. */
export type ExpectedVersion = number | "any";

/** An event to append. The store assigns positions, the id (when absent) and the timestamp. */
export interface NewEvent {
  readonly eventId?: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly data: unknown;
  readonly metadata?: EventMetadata;
}

export interface EventMetadata {
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly [key: string]: unknown;
}

/** An event as stored. */
export interface RecordedEvent {
  readonly eventId: string;
  readonly stream: string;
  /** 1-based position within its stream. After appending it, the stream's version is this number. */
  readonly streamVersion: number;
  /** Position in the store-wide log. Strictly increasing, not necessarily contiguous. */
  readonly globalPosition: number;
  readonly type: string;
  readonly schemaVersion: number;
  readonly data: unknown;
  readonly metadata: EventMetadata;
  /** ISO-8601 timestamp of the append. */
  readonly recordedAt: string;
}

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
export interface EventStore {
  readStream(stream: string): Promise<Result<StreamSlice, DependencyUnavailable>>;
  appendToStream(
    stream: string,
    events: readonly NewEvent[],
    options: { readonly expectedVersion: ExpectedVersion },
  ): Promise<Result<AppendResult, ConcurrencyConflict | DependencyUnavailable>>;
  /** Events with `globalPosition > after`, in order, at most `limit` of them. */
  readAll(options: {
    readonly after: number;
    readonly limit: number;
  }): Promise<Result<readonly RecordedEvent[], DependencyUnavailable>>;
}

/** Remembers how far each event handler has read the global log. */
export interface CheckpointStore {
  /** The last processed global position, 0 when the handler has never run. */
  load(name: string): Promise<Result<number, DependencyUnavailable>>;
  save(name: string, position: number): Promise<Result<void, DependencyUnavailable>>;
}
