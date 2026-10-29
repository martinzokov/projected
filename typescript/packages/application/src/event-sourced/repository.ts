import { Result, panic, type AnyAggregate, type Decision, type EventOf, type StateOf } from "@projected/domain/event-sourced";
import { eventMetadataFrom } from "../event-metadata.js";
import { ConcurrencyConflict, type DependencyUnavailable } from "../errors.js";
import type { ExecutionContext, NewEvent, RecordedEvent } from "../ports.js";
import type { EventStore, SnapshotStore } from "./ports.js";
import { retryOnConflict } from "../retry.js";
import { noTelemetry, type Telemetry } from "../telemetry.js";

/** An aggregate's state as loaded from its stream. */
export interface LoadedAggregate<A extends AnyAggregate> {
  readonly id: string;
  readonly state: StateOf<A>;
  /** Number of events in the stream; 0 when the aggregate does not exist yet. */
  readonly version: number;
}

/** The outcome of a successful decision: what was appended and the state it led to. */
export interface ExecutedDecision<A extends AnyAggregate> extends LoadedAggregate<A> {
  readonly events: ReadonlyArray<EventOf<A>>;
}

/** Loads aggregates from, and appends their decisions to, an event store. */
export interface AggregateRepository<A extends AnyAggregate> {
  readonly aggregate: A;
  load(id: string): Promise<Result<LoadedAggregate<A>, DependencyUnavailable>>;
  /**
   * Load the aggregate, run `decide` on its current state and append the resulting events,
   * guarded by optimistic concurrency. On a conflict the whole cycle is retried with fresh state,
   * so `decide` must be pure — it can run more than once.
   */
  execute<E>(
    id: string,
    decide: (state: StateOf<A>) => Decision<A, E>,
    context?: ExecutionContext,
  ): Promise<Result<ExecutedDecision<A>, E | ConcurrencyConflict | DependencyUnavailable>>;
}

export interface AggregateRepositoryOptions {
  /** How many times to run the load–decide–append cycle before giving up on conflicts. Defaults to 3. */
  readonly maxAttempts?: number;
  /** Records a span per load and per decision. Defaults to none. */
  readonly telemetry?: Telemetry;
  /**
   * Where snapshots are kept, for an aggregate that opts in (`snapshot` in `defineAggregate`).
   * Without it, every load folds the whole stream.
   */
  readonly snapshots?: SnapshotStore;
}

/** An {@link AggregateRepository} over any {@link EventStore}. */
export function aggregateRepository<A extends AnyAggregate>(
  aggregate: A,
  store: EventStore,
  options: AggregateRepositoryOptions = {},
): AggregateRepository<A> {
  const maxAttempts = options.maxAttempts ?? 3;
  const telemetry = options.telemetry ?? noTelemetry;

  const decodeAll = (events: readonly RecordedEvent[]): EventOf<A>[] =>
    events.map((recorded) =>
      aggregate
        .decode(recorded)
        .match({
          ok: (event) => event as EventOf<A>,
          // Stored events are our own data. Failing to read them is a defect, not a business outcome.
          err: (error) => panic(`${recorded.stream}@${recorded.streamVersion}: ${error.message}`, error),
        }),
    );

  const policy = aggregate.snapshot;
  const snapshots = policy === undefined ? undefined : options.snapshots;
  const snapshotFailed = (step: "load" | "save") => telemetry.count("projected.snapshot.failures", 1, { "projected.aggregate": aggregate.name, "projected.step": step });

  /** The latest snapshot this version of the aggregate can use. Anything less is no snapshot: snapshots are disposable. */
  const snapshotOf = async (stream: string): Promise<{ readonly version: number; readonly state: StateOf<A> } | undefined> => {
    if (policy === undefined || snapshots === undefined) return undefined;
    const loaded = await snapshots.load(stream);
    if (loaded.isErr()) {
      snapshotFailed("load");
      return undefined;
    }
    const snapshot = loaded.value;
    if (snapshot === undefined || snapshot.schemaVersion !== policy.version) return undefined;
    const parsed = policy.schema.safeParse(snapshot.state);
    return parsed.success ? { version: snapshot.version, state: parsed.data as StateOf<A> } : undefined;
  };

  const load = (id: string): Promise<Result<LoadedAggregate<A>, DependencyUnavailable>> =>
    telemetry.span(`load ${aggregate.name}`, { attributes: { "projected.stream": aggregate.streamName(id) } }, async (span) => {
      const stream = aggregate.streamName(id);
      const from = await snapshotOf(stream);
      let slice = await store.readStream(stream, from === undefined ? undefined : { after: from.version });
      // A snapshot ahead of its stream belongs to a store that was reset: fold from the start.
      const usable = from !== undefined && slice.isOk() && slice.value.version >= from.version ? from : undefined;
      if (from !== undefined && usable === undefined) slice = await store.readStream(stream);
      return slice.map(({ version, events }) => {
        span.setAttributes({ "projected.stream.version": version, ...(usable === undefined ? {} : { "projected.snapshot.version": usable.version }) });
        return { id, version, state: aggregate.fold(decodeAll(events), usable?.state) };
      });
    });

  /** After an append that passed another multiple of `every`, store the state reached. */
  const snapshotAfter = async (stream: string, before: number, after: number, state: StateOf<A>) => {
    if (policy === undefined || snapshots === undefined) return;
    if (Math.floor(after / policy.every) === Math.floor(before / policy.every)) return;
    const encoded = policy.schema.safeParse(state);
    if (!encoded.success) return snapshotFailed("save");
    const saved = await snapshots.save(stream, { version: after, schemaVersion: policy.version, state: encoded.data });
    if (saved.isErr()) snapshotFailed("save");
  };

  const attempt = async <E>(
    id: string,
    decide: (state: StateOf<A>) => Decision<A, E>,
    context: ExecutionContext | undefined,
  ): Promise<Result<ExecutedDecision<A>, E | ConcurrencyConflict | DependencyUnavailable>> =>
    Result.gen(async function* () {
      const loaded = yield* Result.await(load(id));
      const events = yield* decide(loaded.state);
      if (events.length === 0) return Result.ok({ ...loaded, events });

      const metadata = eventMetadataFrom(context);
      const newEvents: NewEvent[] = events.map((event) => ({
        ...aggregate.encode(event),
        ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
      }));
      const appended = yield* Result.await(
        store.appendToStream(aggregate.streamName(id), newEvents, { expectedVersion: loaded.version }),
      );
      const state = aggregate.fold(events, loaded.state);
      await snapshotAfter(aggregate.streamName(id), loaded.version, appended.version, state);
      return Result.ok({ id, events, version: appended.version, state });
    });

  return {
    aggregate,
    load,
    execute: (id, decide, context) =>
      telemetry.span(`execute ${aggregate.name}`, { attributes: { "projected.stream": aggregate.streamName(id) } }, (span) =>
        retryOnConflict(() => attempt(id, decide, context), maxAttempts, span),
      ),
  };
}
