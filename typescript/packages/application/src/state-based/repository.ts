import { Result, panic, type AnyAggregate, type Decision, type EventOf, type StateOf } from "@projected/domain/state-based";
import { eventMetadataFrom } from "../event-metadata.js";
import { ConcurrencyConflict, type DependencyUnavailable } from "../errors.js";
import type { ExecutionContext, NewEvent } from "../ports.js";
import type { StateStore } from "./ports.js";
import { retryOnConflict } from "../retry.js";
import { noTelemetry, type Telemetry } from "../telemetry.js";

/** An aggregate's state as loaded from the store. */
export interface LoadedAggregate<A extends AnyAggregate> {
  readonly id: string;
  /** Absent when the aggregate does not exist: never saved, or removed. */
  readonly state: StateOf<A> | undefined;
  /** Number of saves; 0 when the aggregate has never been saved. */
  readonly version: number;
}

/** The outcome of a successful decision: the state it stored and the events it emitted. */
export interface ExecutedDecision<A extends AnyAggregate> extends LoadedAggregate<A> {
  readonly events: ReadonlyArray<EventOf<A>>;
}

/** Loads aggregates from, and saves their decisions to, a state store. */
export interface AggregateRepository<A extends AnyAggregate> {
  readonly aggregate: A;
  load(id: string): Promise<Result<LoadedAggregate<A>, DependencyUnavailable>>;
  /**
   * Load the aggregate, run `decide` on its current state and save the change it returns,
   * together with the events it emits, guarded by optimistic concurrency. On a conflict the
   * whole cycle is retried with fresh state, so `decide` must be pure — it can run more than once.
   */
  execute<E>(
    id: string,
    decide: (state: StateOf<A> | undefined) => Decision<A, E>,
    context?: ExecutionContext,
  ): Promise<Result<ExecutedDecision<A>, E | ConcurrencyConflict | DependencyUnavailable>>;
}

export interface AggregateRepositoryOptions {
  /** How many times to run the load–decide–save cycle before giving up on conflicts. Defaults to 3. */
  readonly maxAttempts?: number;
  /** Records a span per load and per decision. Defaults to none. */
  readonly telemetry?: Telemetry;
}

/** An {@link AggregateRepository} over any {@link StateStore}. */
export function aggregateRepository<A extends AnyAggregate>(
  aggregate: A,
  store: StateStore,
  options: AggregateRepositoryOptions = {},
): AggregateRepository<A> {
  const maxAttempts = options.maxAttempts ?? 3;
  const telemetry = options.telemetry ?? noTelemetry;

  const load = (id: string): Promise<Result<LoadedAggregate<A>, DependencyUnavailable>> =>
    telemetry.span(`load ${aggregate.name}`, { attributes: { "projected.aggregate.key": aggregate.key(id) } }, async (span) => {
      const stored = await store.load(aggregate.key(id));
      return stored.map(({ version, state }) => {
        span.setAttributes({ "projected.aggregate.version": version });
        if (state === undefined) return { id, version, state: undefined };
        const decoded = aggregate.decode(state).match({
          ok: (value) => value as StateOf<A>,
          // Stored state is our own data. Failing to read it is a defect, not a business outcome.
          err: (error) => panic(`${aggregate.key(id)}@${version}: ${error.message}`, error),
        });
        return { id, version, state: decoded };
      });
    });

  const attempt = async <E>(
    id: string,
    decide: (state: StateOf<A> | undefined) => Decision<A, E>,
    context: ExecutionContext | undefined,
  ): Promise<Result<ExecutedDecision<A>, E | ConcurrencyConflict | DependencyUnavailable>> =>
    Result.gen(async function* () {
      const loaded = yield* Result.await(load(id));
      const change = yield* decide(loaded.state);
      if (change.kind === "none") return Result.ok({ ...loaded, events: [] });
      // Removing what does not exist, and saying nothing about it, changes nothing.
      if (change.kind === "remove" && loaded.state === undefined && change.events.length === 0) {
        return Result.ok({ ...loaded, events: [] });
      }

      const metadata = eventMetadataFrom(context);
      const events: NewEvent[] = change.events.map((event) => ({
        ...aggregate.encodeEvent(event),
        ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
      }));
      const state = change.kind === "change" ? aggregate.encode(change.state) : null;
      const saved = yield* Result.await(
        store.save(aggregate.key(id), { state, events }, { expectedVersion: loaded.version }),
      );
      return Result.ok({
        id,
        version: saved.version,
        state: change.kind === "change" ? change.state : undefined,
        events: change.events,
      });
    });

  return {
    aggregate,
    load,
    execute: (id, decide, context) =>
      telemetry.span(`execute ${aggregate.name}`, { attributes: { "projected.aggregate.key": aggregate.key(id) } }, (span) =>
        retryOnConflict(() => attempt(id, decide, context), maxAttempts, span),
      ),
  };
}
