/**
 * @projected/store-memory — in-memory implementations of every storage port. State lives as long
 * as the returned objects. Use them in tests and local development; they are also the reference
 * behaviour the conformance suites in `@projected/testing` check other stores against.
 *
 * This entry point holds the stores both flavours share. The aggregate store comes from the
 * project's flavour, which also re-exports these: `@projected/store-memory/event-sourced`
 * (`inMemoryEventStore`) or `@projected/store-memory/state-based` (`inMemoryStateStore`).
 */
export { inMemoryCheckpointStore } from "./checkpoints.js";
export { inMemoryIdempotencyStore } from "./idempotency.js";
export { inMemoryDocumentStore } from "./documents.js";
