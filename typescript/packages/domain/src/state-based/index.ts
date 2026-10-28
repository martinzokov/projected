/**
 * @projected/domain/state-based — the domain kernel for state-based projects.
 *
 * An aggregate is stored as its current state: `defineAggregate` declares the state's schema,
 * and decisions return the next state (`changeTo`, `remove`, `noChange`), optionally emitting
 * events. Re-exports the shared kernel, so domain code needs this one import.
 */
export * from "../index.js";
export {
  StateDecodingFailed,
  changeTo,
  defineAggregate,
  noChange,
  remove,
  type AggregateDefinition,
  type AnyAggregate,
  type Change,
  type Decision,
  type DefineAggregateOptions,
  type EventOf,
  type SerializedState,
  type StateOf,
} from "./aggregate.js";
