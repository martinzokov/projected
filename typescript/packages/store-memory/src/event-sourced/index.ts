/** In-memory stores for event-sourced projects: the event store, plus every shared store. */
export * from "../index.js";
export { inMemoryEventStore, type InMemoryEventStore, type InMemoryEventStoreOptions } from "./event-store.js";
export { inMemorySnapshotStore } from "./snapshots.js";
