/** Test helpers for event-sourced projects: `given` over event histories, the EventStore conformance suite, and every shared helper. */
export * from "../index.js";
export { given, type Then, type When } from "./given.js";
export { eventStoreConformance } from "./event-store-conformance.js";
export { anyHistory, everyHistoryFolds } from "./properties.js";
