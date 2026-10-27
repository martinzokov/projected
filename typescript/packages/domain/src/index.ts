/**
 * @projected/domain — the pure kernel your domain layer is allowed to import.
 *
 * Everything here is synchronous, deterministic and free of I/O. The architecture rules allow
 * `src/domain/**` to import this package and nothing else outside the domain.
 */
export {
  Err,
  Ok,
  Panic,
  Result,
  TaggedError,
  isPanic,
  isTaggedError,
  matchError,
  matchErrorPartial,
  panic,
} from "better-result";
export type { AnyTaggedError, InferErr, InferOk } from "better-result";
export { z } from "zod";

export {
  defineError,
  isBusinessErrorClass,
  type AnyBusinessErrorClass,
  type BusinessError,
  type BusinessErrorClass,
  type DefineErrorOptions,
} from "./error.js";
export {
  EventDecodingFailed,
  defineEvent,
  migration,
  type AnyEventDefinition,
  type DefineEventOptions,
  type DomainEvent,
  type EventDefinition,
  type EventMigration,
  type EventOfDefinition,
  type SerializedEvent,
} from "./event.js";
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
