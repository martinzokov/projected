/**
 * @projected/domain/event-sourced — the domain kernel for event-sourced projects.
 *
 * An aggregate's state is folded from its events: `defineAggregate` declares an initial state
 * and an `evolve` handler per event, and decisions return the events that follow. Re-exports the
 * shared kernel, so domain code needs this one import.
 */
export * from "../index.js";
export {
  defineAggregate,
  type AggregateDefinition,
  type AnyAggregate,
  type Decision,
  type DefineAggregateOptions,
  type EventOf,
  type EvolveHandlers,
  type StateOf,
} from "./aggregate.js";
