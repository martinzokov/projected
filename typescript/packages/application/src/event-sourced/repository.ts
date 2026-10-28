import { Result, panic, type AnyAggregate, type Decision, type EventOf, type StateOf } from "@projected/domain/event-sourced";
import { eventMetadataFrom } from "../event-metadata.js";
import { ConcurrencyConflict, type DependencyUnavailable } from "../errors.js";
import type { ExecutionContext, NewEvent, RecordedEvent } from "../ports.js";
import type { EventStore } from "./ports.js";
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

  const load = (id: string): Promise<Result<LoadedAggregate<A>, DependencyUnavailable>> =>
    telemetry.span(`load ${aggregate.name}`, { attributes: { "projected.stream": aggregate.streamName(id) } }, async (span) => {
      const slice = await store.readStream(aggregate.streamName(id));
      return slice.map(({ version, events }) => {
        span.setAttributes({ "projected.stream.version": version });
        return { id, version, state: aggregate.fold(decodeAll(events)) };
      });
    });

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
      return Result.ok({ id, events, version: appended.version, state: aggregate.fold(events, loaded.state) });
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
