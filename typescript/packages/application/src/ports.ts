import type { Result, z } from "@projected/domain";
import type { DependencyFailure, DependencyUnavailable } from "./errors.js";
import type { OperationResult } from "./wire.js";

/**
 * Driven ports the framework itself needs, shared by both flavours. The aggregate store port is
 * the flavour's (`EventStore` or `StateStore`). Adapters live in infrastructure packages
 * (`@projected/store-memory`, `@projected/store-postgres`, `@projected/runtime`, ...); use cases
 * only see these interfaces.
 */

/** Who a message comes from, as established by an {@link Authenticator}. */
export interface Principal {
  /** Stable identifier of the user or service. */
  readonly id: string;
  readonly kind: "user" | "service";
  /** What the principal may do; checked against each operation's `access`. */
  readonly permissions: readonly string[];
  /** Provider-specific facts (email, tenant, ...). Never used for authorization by the framework. */
  readonly claims: Readonly<Record<string, unknown>>;
}

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
  /** The authenticated sender. Absent for anonymous requests. */
  readonly principal?: Principal;
  /** Trace context (W3C `traceparent`/`tracestate`) to continue in anything this message causes. */
  readonly trace?: Readonly<Record<string, string>>;
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

/** Expected aggregate version for optimistic concurrency: an exact version (0 = never written) or `"any"`. */
export type ExpectedVersion = number | "any";

/** An event to record. The store assigns positions, the id (when absent) and the timestamp. */
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

/** An event as recorded: in an event store's streams, or in a state store's outbox. */
export interface RecordedEvent {
  readonly eventId: string;
  /** Storage key of the aggregate it belongs to (`student-s-1`) — its stream, when event-sourced. */
  readonly stream: string;
  /** 1-based position among that aggregate's events. */
  readonly streamVersion: number;
  /** Position in the store-wide log. Strictly increasing, not necessarily contiguous. */
  readonly globalPosition: number;
  readonly type: string;
  readonly schemaVersion: number;
  readonly data: unknown;
  readonly metadata: EventMetadata;
  /** ISO-8601 timestamp of the write that recorded it. */
  readonly recordedAt: string;
}

/**
 * The ordered log of every recorded event — what event handlers and relays read. Both flavours'
 * stores provide it: an event store's global log, or a state store's outbox.
 */
export interface EventLog {
  /** Events with `globalPosition > after`, in order, at most `limit` of them. */
  readAll(options: {
    readonly after: number;
    readonly limit: number;
  }): Promise<Result<readonly RecordedEvent[], DependencyUnavailable>>;
}

/**
 * Something the service cannot serve without — its database, its broker — asked by readiness
 * probes (`GET /health/ready`). Answer promptly: bound the check with a timeout, since a probe
 * that hangs is worse than one that fails.
 */
export interface ReadinessCheck {
  /** Names the dependency in the health report: `postgres`, `kafka`. */
  readonly name: string;
  check(): Promise<Result<void, DependencyUnavailable | DependencyFailure>>;
}

/** Remembers how far each event handler has read the global log. */
export interface CheckpointStore {
  /** The last processed global position, 0 when the handler has never run. */
  load(name: string): Promise<Result<number, DependencyUnavailable>>;
  save(name: string, position: number): Promise<Result<void, DependencyUnavailable>>;
}

/**
 * Establishes who sent a message, from its transport headers (lower-cased names). Implemented by
 * auth adapters such as `@projected/auth-better-auth`; called by transports, never by use cases.
 * Missing or invalid credentials are `undefined` (anonymous), not an error: whether anonymous
 * callers may proceed is each operation's `access` rule.
 */
export interface Authenticator {
  authenticate(credentials: {
    readonly headers: Readonly<Record<string, string>>;
  }): Promise<Result<Principal | undefined, DependencyUnavailable>>;
}

/** The state of an idempotency key, as returned when a request tries to claim it. */
export type IdempotencyClaim =
  /** First time this key is seen (or its previous claim expired): the caller must run the request, then complete or release. */
  | { readonly status: "claimed" }
  /** Already run to a business outcome: replay `result` instead of running again. */
  | { readonly status: "completed"; readonly fingerprint: string; readonly result: OperationResult }
  /** Being run right now by someone else. */
  | { readonly status: "in-progress"; readonly fingerprint: string };

/**
 * Remembers the outcome of commands sent with an idempotency key, so that a retried or
 * redelivered command is answered from memory instead of being run twice.
 */
export interface IdempotencyStore {
  /**
   * Atomically claim `key` for a request whose input hashes to `fingerprint`. A claim that is not
   * completed within `lockMs` may be taken over; a completed key is forgotten after `ttlMs`.
   */
  claim(
    key: string,
    fingerprint: string,
    options: { readonly lockMs: number; readonly ttlMs: number },
  ): Promise<Result<IdempotencyClaim, DependencyUnavailable>>;
  /** Record the business outcome of a claimed key. */
  complete(key: string, result: OperationResult): Promise<Result<void, DependencyUnavailable>>;
  /** Give up a claim without an outcome (the request failed for infrastructure reasons), so it can be retried. */
  release(key: string): Promise<Result<void, DependencyUnavailable>>;
}

/** A field-equality filter over a document's top-level fields. */
export type DocumentFilter<T> = { readonly [K in keyof T]?: T[K] };

export interface FindOptions<T> {
  readonly limit?: number;
  /** Order by one top-level field, ascending. Defaults to the document id. */
  readonly orderBy?: keyof T & string;
}

/**
 * A collection of JSON documents keyed by id — storage for read models and other simple state.
 * Documents are validated against the collection's schema when read, so a stored shape that no
 * longer matches is reported instead of flowing into the application.
 */
export interface DocumentCollection<T> {
  get(id: string): Promise<Result<T | undefined, DependencyUnavailable | DependencyFailure>>;
  /** Insert or replace. */
  put(id: string, document: T): Promise<Result<void, DependencyUnavailable>>;
  delete(id: string): Promise<Result<void, DependencyUnavailable>>;
  find(filter: DocumentFilter<T>, options?: FindOptions<T>): Promise<Result<readonly T[], DependencyUnavailable | DependencyFailure>>;
}

/** Opens document collections. One store per database; collections are cheap to open. */
export interface DocumentStore {
  /** `name` is kebab-case or snake_case and identifies the collection across deployments. */
  collection<S extends z.ZodType>(name: string, schema: S): DocumentCollection<z.output<S>>;
}
