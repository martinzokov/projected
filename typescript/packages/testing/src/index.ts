/**
 * @projected/testing — test helpers both flavours share: deterministic clocks and ids, test
 * principals and authenticators, recording telemetry, and the conformance suites for checkpoint,
 * idempotency and document stores. The message transport suite is `@projected/testing/messaging`.
 *
 * `given` and the aggregate store's conformance suite come from the project's flavour, which also
 * re-exports all of this: `@projected/testing/event-sourced` or `@projected/testing/state-based`.
 */
export { fixedClock, sequentialIds, type FixedClock } from "./doubles.js";
export { principal, tokenAuthenticator } from "./auth.js";
export { recordingTelemetry, type RecordedSpan, type RecordingTelemetry } from "./telemetry.js";
export { checkpointStoreConformance, documentStoreConformance, idempotencyStoreConformance } from "./store-conformance.js";
export { fc, forAll, fromSchema, type ForAllOptions } from "./properties.js";
