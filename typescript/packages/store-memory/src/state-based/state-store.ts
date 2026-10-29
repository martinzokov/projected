import {
  ConcurrencyConflict,
  Result,
  type Clock,
  type DependencyUnavailable,
  type ExpectedVersion,
  type IdGenerator,
  type RecordedEvent,
  type SaveResult,
  type SerializedState,
  type StateStore,
  type StateWrite,
  type StoredState,
} from "@projected/application/state-based";
import { randomUUID } from "node:crypto";
import { asJson } from "../json.js";
import { readAfter } from "../log.js";

export interface InMemoryStateStoreOptions {
  readonly clock?: Clock;
  /** Generates event ids for events saved without one. */
  readonly ids?: IdGenerator;
}

/** A {@link StateStore} that keeps everything in memory, plus read access for assertions. */
export interface InMemoryStateStore extends StateStore {
  /** Every event in the outbox, in global order. */
  readonly all: readonly RecordedEvent[];
  /** The events one aggregate has emitted that are still in the outbox, in order. */
  eventsOf(key: string): readonly RecordedEvent[];
  /** The state stored under `key`; undefined when never saved or removed. */
  stateOf(key: string): SerializedState | undefined;
}

interface Row {
  readonly version: number;
  readonly state: SerializedState | undefined;
  /** Events this aggregate has emitted, pruned ones included: its next event's number. */
  readonly emitted: number;
}

/** Create an in-memory state store. State lives as long as the returned object. */
export function inMemoryStateStore(options: InMemoryStateStoreOptions = {}): InMemoryStateStore {
  const clock = options.clock ?? { now: () => new Date() };
  const ids = options.ids ?? { next: () => randomUUID() };
  let log: RecordedEvent[] = [];
  let position = 0;
  const rows = new Map<string, Row>();

  const matches = (expected: ExpectedVersion, actual: number) => expected === "any" || expected === actual;

  return {
    get all() {
      return [...log];
    },
    eventsOf: (key) => log.filter((event) => event.stream === key),
    stateOf: (key) => asJson(rows.get(key)?.state),

    load: async (key): Promise<Result<StoredState, DependencyUnavailable>> => {
      const row = rows.get(key);
      return Result.ok({ version: row?.version ?? 0, state: asJson(row?.state) });
    },

    save: async (
      key: string,
      write: StateWrite,
      { expectedVersion }: { readonly expectedVersion: ExpectedVersion },
    ): Promise<Result<SaveResult, ConcurrencyConflict | DependencyUnavailable>> => {
      const row = rows.get(key) ?? { version: 0, state: undefined, emitted: 0 };
      if (!matches(expectedVersion, row.version)) {
        return Result.err(
          new ConcurrencyConflict({
            key,
            expectedVersion,
            actualVersion: row.version,
            message: `${key} is at version ${row.version}, expected ${expectedVersion}`,
          }),
        );
      }
      const recordedAt = clock.now().toISOString();
      const recorded = write.events.map(
        (event, index): RecordedEvent => ({
          eventId: event.eventId ?? ids.next(),
          stream: key,
          streamVersion: row.emitted + index + 1,
          globalPosition: position + index + 1,
          type: event.type,
          schemaVersion: event.schemaVersion,
          // Stored as JSON, as a real store would, so nothing shares references with the caller.
          data: asJson(event.data),
          metadata: asJson(event.metadata ?? {}),
          recordedAt,
        }),
      );
      const version = row.version + 1;
      rows.set(key, {
        version,
        state: write.state === null ? undefined : asJson(write.state),
        emitted: row.emitted + recorded.length,
      });
      log.push(...recorded);
      position += recorded.length;
      return Result.ok({ version, events: recorded });
    },

    readAll: async ({ after, limit }) => Result.ok(readAfter(log, after, limit)),

    pruneOutbox: async ({ upTo, recordedBefore }) => {
      const before = Date.parse(recordedBefore);
      const kept = log.filter((event) => event.globalPosition > upTo || Date.parse(event.recordedAt) >= before);
      const pruned = log.length - kept.length;
      log = kept;
      return Result.ok(pruned);
    },
  };
}
