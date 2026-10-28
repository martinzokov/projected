/**
 * @projected/application/event-sourced — the application layer for event-sourced projects.
 *
 * Adds the `EventStore` port and the aggregate repository that folds streams, decides and appends.
 * Re-exports the shared application layer and the event-sourced domain kernel, so use cases and
 * contracts need this one import.
 */
export * from "../index.js";
export * from "@projected/domain/event-sourced";
export type { AppendResult, EventStore, StreamSlice } from "./ports.js";
export {
  aggregateRepository,
  type AggregateRepository,
  type AggregateRepositoryOptions,
  type ExecutedDecision,
  type LoadedAggregate,
} from "./repository.js";
