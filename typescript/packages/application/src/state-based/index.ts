/**
 * @projected/application/state-based — the application layer for state-based projects.
 *
 * Adds the `StateStore` port and the aggregate repository that loads state, decides and saves it
 * together with its outbox events. Re-exports the shared application layer and the state-based
 * domain kernel, so use cases and contracts need this one import.
 */
export * from "../index.js";
export * from "@projected/domain/state-based";
export type { SaveResult, StateStore, StateWrite, StoredState } from "./ports.js";
export {
  aggregateRepository,
  type AggregateRepository,
  type AggregateRepositoryOptions,
  type ExecutedDecision,
  type LoadedAggregate,
} from "./repository.js";
