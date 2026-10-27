/**
 * @projected/store-memory — in-memory implementations of every storage port. State lives as long
 * as the returned objects. Use them in tests and local development; they are also the reference
 * behaviour the conformance suites in `@projected/testing` check other stores against.
 */
export { inMemoryEventStore, type InMemoryEventStore, type InMemoryEventStoreOptions } from "./event-store.js";
export { inMemoryCheckpointStore } from "./checkpoints.js";
export { inMemoryIdempotencyStore } from "./idempotency.js";
export { inMemoryDocumentStore } from "./documents.js";
