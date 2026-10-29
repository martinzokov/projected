import {
  ConcurrencyConflict,
  Result,
  type AppendResult,
  type Clock,
  type DependencyUnavailable,
  type EventStore,
  type ExpectedVersion,
  type IdGenerator,
  type NewEvent,
  type RecordedEvent,
  type StreamSlice,
} from "@projected/application/event-sourced";
import { randomUUID } from "node:crypto";
import { asJson } from "../json.js";
import { readAfter } from "../log.js";

export interface InMemoryEventStoreOptions {
  readonly clock?: Clock;
  /** Generates event ids for events appended without one. */
  readonly ids?: IdGenerator;
}

/** An {@link EventStore} that keeps everything in memory, plus read access for assertions. */
export interface InMemoryEventStore extends EventStore {
  /** Every recorded event, in global order. */
  readonly all: readonly RecordedEvent[];
  /** Recorded events of one stream, in order. */
  stream(name: string): readonly RecordedEvent[];
}

/** Create an in-memory event store. State lives as long as the returned object. */
export function inMemoryEventStore(options: InMemoryEventStoreOptions = {}): InMemoryEventStore {
  const clock = options.clock ?? { now: () => new Date() };
  const ids = options.ids ?? { next: () => randomUUID() };
  const log: RecordedEvent[] = [];
  const streams = new Map<string, RecordedEvent[]>();

  const matches = (expected: ExpectedVersion, actual: number) => expected === "any" || expected === actual;

  return {
    get all() {
      return [...log];
    },
    stream: (name) => [...(streams.get(name) ?? [])],

    readStream: async (stream, options = {}): Promise<Result<StreamSlice, DependencyUnavailable>> => {
      const events = streams.get(stream) ?? [];
      const after = options.after ?? 0;
      return Result.ok({ version: events.length, events: events.filter((event) => event.streamVersion > after) });
    },

    appendToStream: async (
      stream: string,
      events: readonly NewEvent[],
      { expectedVersion }: { readonly expectedVersion: ExpectedVersion },
    ): Promise<Result<AppendResult, ConcurrencyConflict | DependencyUnavailable>> => {
      const existing = streams.get(stream) ?? [];
      if (!matches(expectedVersion, existing.length)) {
        return Result.err(
          new ConcurrencyConflict({
            key: stream,
            expectedVersion,
            actualVersion: existing.length,
            message: `Stream ${stream} is at version ${existing.length}, expected ${expectedVersion}`,
          }),
        );
      }
      const recordedAt = clock.now().toISOString();
      const recorded = events.map(
        (event, index): RecordedEvent => ({
          eventId: event.eventId ?? ids.next(),
          stream,
          streamVersion: existing.length + index + 1,
          globalPosition: log.length + index + 1,
          type: event.type,
          schemaVersion: event.schemaVersion,
          // Stored as JSON, as a real store would, so nothing shares references with the caller.
          data: asJson(event.data),
          metadata: asJson(event.metadata ?? {}),
          recordedAt,
        }),
      );
      streams.set(stream, [...existing, ...recorded]);
      log.push(...recorded);
      return Result.ok({ version: existing.length + recorded.length, events: recorded });
    },

    readAll: async ({ after, limit }) => Result.ok(readAfter(log, after, limit)),
  };
}
