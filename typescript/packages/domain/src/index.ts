/**
 * @projected/domain — the pure kernel your domain layer is allowed to import.
 *
 * Everything here is synchronous, deterministic and free of I/O. The architecture rules allow
 * `src/domain/**` to import this package and nothing else outside the domain.
 *
 * This entry point holds what both flavours share: results, schemas, events and business errors.
 * Aggregates come from the project's flavour, which also re-exports all of this:
 * `@projected/domain/event-sourced` or `@projected/domain/state-based`.
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
export { assertJsonCompatible } from "./json.js";
/** A schema migration — for stored events and stored states alike. */
export type { EventMigration as Migration } from "./event.js";
