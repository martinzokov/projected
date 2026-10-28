/**
 * @projected/testing/messaging — the conformance suite for message transports. Its own entry
 * point, so that only a transport's tests need `@projected/messaging`.
 */
export { messageTransportConformance, type TransportConformanceOptions, type TransportUnderTest } from "./transport-conformance.js";
