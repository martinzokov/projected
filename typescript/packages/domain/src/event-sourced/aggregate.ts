import { Result, panic } from "better-result";
import type { z } from "zod";
import {
  EventDecodingFailed,
  type AnyEventDefinition,
  type DomainEvent,
  type EventDefinition,
  type EventOfDefinition,
  type SerializedEvent,
} from "../event.js";
import { CAMEL_CASE } from "../naming.js";

type DataFor<D, Type extends string> = D extends EventDefinition<Type, infer S> ? z.output<S> : never;

/**
 * One handler per event type: how the aggregate's state changes when that event is applied.
 * The mapped type makes the set exhaustive — adding an event to `events` without a handler
 * is a compile error.
 */
// Mapped over the type names rather than remapping keys (`as D["type"]`): a key-remapped
// mapped type loses contextual typing for the handlers while `Events` is being inferred.
export type EvolveHandlers<S, Events extends readonly AnyEventDefinition[]> = {
  readonly [Type in Events[number]["type"]]: (state: S, data: DataFor<Events[number], Type>) => S;
};

/** An event-sourced aggregate: a consistency boundary whose state is a fold over its events. */
export interface AggregateDefinition<
  Name extends string = string,
  S = unknown,
  Events extends readonly AnyEventDefinition[] = readonly AnyEventDefinition[],
> {
  /** Stream category. A stream is named `<name>-<id>`, so the name never contains a dash. */
  readonly name: Name;
  /** State before any event. A function, so every fold starts from a fresh value. */
  readonly initialState: () => S;
  readonly events: Events;
  /** Apply one event to a state. */
  evolve(state: S, event: EventOfDefinition<Events[number]>): S;
  /** Apply events in order, starting from `from` (defaults to `initialState`). */
  fold(events: Iterable<EventOfDefinition<Events[number]>>, from?: S): S;
  /** The event stream holding the aggregate with this id. */
  streamName(id: string): string;
  encode(event: EventOfDefinition<Events[number]>): SerializedEvent;
  decode(serialized: SerializedEvent): Result<EventOfDefinition<Events[number]>, EventDecodingFailed>;
}

/** Any aggregate definition. */
// `any` in the state position is deliberate: state is invariant, so `unknown` would not match
// concrete aggregates. It never leaks into user code — `StateOf` recovers the real type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAggregate = AggregateDefinition<string, any, readonly AnyEventDefinition[]>;

/** The state type of an aggregate. */
export type StateOf<A extends AnyAggregate> = ReturnType<A["initialState"]>;

/** The union of event values an aggregate can produce. */
export type EventOf<A extends AnyAggregate> = EventOfDefinition<A["events"][number]>;

/**
 * The outcome of a decision function: the events to append, or the business rule that was broken.
 * An empty array means "nothing to do" — an idempotent no-op.
 */
export type Decision<A extends AnyAggregate, E = never> = Result<ReadonlyArray<EventOf<A>>, E>;

/** Rejects keys of `H` outside `Allowed` — the excess-property check generic arguments do not get. */
type NoExtraKeys<H, Allowed extends PropertyKey> = H & { readonly [K in Exclude<keyof H, Allowed>]: never };

export interface DefineAggregateOptions<
  Name extends string,
  S,
  Events extends readonly AnyEventDefinition[],
  Handlers extends EvolveHandlers<NoInfer<S>, NoInfer<Events>> = EvolveHandlers<NoInfer<S>, NoInfer<Events>>,
> {
  readonly name: Name;
  /**
   * State before any event. Annotate the return type — `(): StudentState => ({ status: "unknown" })` —
   * since that annotation is where the aggregate's state type comes from.
   */
  readonly initialState: () => S;
  readonly events: Events;
  readonly evolve: NoExtraKeys<Handlers, Events[number]["type"]>;
}

/**
 * Define an event-sourced aggregate.
 *
 * ```ts
 * export const Student = defineAggregate({
 *   name: "student",
 *   initialState: (): StudentState => ({ status: "unknown" }),
 *   events: [StudentEnlisted, StudentLeft],
 *   evolve: {
 *     StudentEnlisted: (_state, data) => ({ status: "enlisted", ...data }),
 *     StudentLeft: (state) => ({ ...state, status: "left" }),
 *   },
 * });
 * ```
 *
 * Decisions are plain functions next to it: `(state, input) => Decision<typeof Student, Errors>`.
 */
// `Handlers` is its own type parameter, constrained rather than spelled out, so that handler
// return values are contextually typed by the fixed state type — otherwise TypeScript widens
// literals such as `status: "enlisted"` to `string` while it is still inferring `S`.
export function defineAggregate<
  const Name extends string,
  S,
  const Events extends readonly AnyEventDefinition[],
  Handlers extends EvolveHandlers<NoInfer<S>, NoInfer<Events>>,
>(options: DefineAggregateOptions<Name, S, Events, Handlers>): AggregateDefinition<Name, S, Events> {
  if (!CAMEL_CASE.test(options.name)) {
    panic(`defineAggregate: name "${options.name}" must be camelCase with no dashes, e.g. "student"`);
  }
  const byType = new Map<string, AnyEventDefinition>();
  for (const definition of options.events) {
    if (byType.has(definition.type)) {
      panic(`defineAggregate("${options.name}"): event ${definition.type} is listed twice`);
    }
    byType.set(definition.type, definition);
  }
  const handlers = options.evolve as unknown as Record<string, (state: S, data: unknown) => S>;
  for (const type of byType.keys()) {
    if (typeof handlers[type] !== "function") {
      panic(`defineAggregate("${options.name}"): no evolve handler for ${type}`);
    }
  }
  for (const type of Object.keys(handlers)) {
    if (!byType.has(type)) panic(`defineAggregate("${options.name}"): evolve handler for unlisted event ${type}`);
  }

  type Event = EventOfDefinition<Events[number]>;
  const evolve = (state: S, event: Event): S => {
    const handler = handlers[(event as DomainEvent).type];
    if (handler === undefined) {
      return panic(`${options.name}: cannot evolve unknown event ${(event as DomainEvent).type}`);
    }
    return handler(state, (event as DomainEvent).data);
  };

  return {
    name: options.name,
    initialState: options.initialState,
    events: options.events,
    evolve,
    fold: (events, from) => {
      let state = from ?? options.initialState();
      for (const event of events) state = evolve(state, event);
      return state;
    },
    streamName: (id) => `${options.name}-${id}`,
    encode: (event) => {
      const { type, data } = event as DomainEvent;
      const definition = byType.get(type);
      if (definition === undefined) {
        return panic(`${options.name}: cannot encode unknown event ${type}`);
      }
      return { type, schemaVersion: definition.version, data };
    },
    decode: (serialized) => {
      const definition = byType.get(serialized.type);
      if (definition === undefined) {
        return Result.err(
          new EventDecodingFailed({
            type: serialized.type,
            schemaVersion: serialized.schemaVersion,
            message: `${options.name} has no event definition for ${serialized.type}`,
          }),
        );
      }
      return definition.decode(serialized) as Result<Event, EventDecodingFailed>;
    },
  };
}
