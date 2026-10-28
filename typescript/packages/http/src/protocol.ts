import type { DispatchError, OperateError, OperationKind, ValidationIssue } from "@projected/application";

/**
 * The HTTP binding of the projected protocol (see `spec/protocol.md`).
 *
 * Business outcomes — success or a declared business error — are always `200 OK` with an
 * `OperationResult` body. HTTP status codes are reserved for the protocol itself: the request
 * could not be understood, the operation does not exist, or the machinery failed. Those
 * responses use RFC 9457 problem details.
 */

export const HEADERS = {
  messageId: "x-message-id",
  correlationId: "x-correlation-id",
  causationId: "x-causation-id",
  idempotencyKey: "idempotency-key",
  traceparent: "traceparent",
  tracestate: "tracestate",
} as const;

export const PLURAL: Record<OperationKind, "commands" | "queries"> = { command: "commands", query: "queries" };

/** `/commands/enlist-student/version/1` */
export function operationPath(kind: OperationKind, type: string, version: number): string {
  return `/${PLURAL[kind]}/${type}/version/${version}`;
}

/** `enlist-student`, 1 → `enlistStudentV1` */
export function operationId(type: string, version: number): string {
  return `${type.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}V${version}`;
}

/** RFC 9457 problem details. */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly issues?: readonly ValidationIssue[];
}

/** Problem types are URNs so they are stable identifiers, not links that may rot. */
export const PROBLEM_TYPES = {
  notFound: "urn:projected:problem:not-found",
  methodNotAllowed: "urn:projected:problem:method-not-allowed",
  unsupportedMediaType: "urn:projected:problem:unsupported-media-type",
  malformedRequest: "urn:projected:problem:malformed-request",
  payloadTooLarge: "urn:projected:problem:payload-too-large",
  unknownOperation: "urn:projected:problem:unknown-operation",
  unknownTask: "urn:projected:problem:unknown-task",
  unauthenticated: "urn:projected:problem:unauthenticated",
  forbidden: "urn:projected:problem:forbidden",
  requestInProgress: "urn:projected:problem:request-in-progress",
  idempotencyKeyReused: "urn:projected:problem:idempotency-key-reused",
  invalidInput: "urn:projected:problem:invalid-input",
  concurrencyConflict: "urn:projected:problem:concurrency-conflict",
  dependencyUnavailable: "urn:projected:problem:dependency-unavailable",
  dependencyFailure: "urn:projected:problem:dependency-failure",
  internalError: "urn:projected:problem:internal-error",
} as const;

export function problem(type: string, title: string, status: number, detail?: string): Problem {
  return detail === undefined ? { type, title, status } : { type, title, status, detail };
}

/** The protocol-level response for a request that did not reach a business outcome. */
export function problemForDispatchError(error: DispatchError): Problem {
  switch (error._tag) {
    case "UnknownOperation":
      return problem(PROBLEM_TYPES.unknownOperation, "Unknown operation", 404, error.message);
    case "InvalidInput":
      return { ...problem(PROBLEM_TYPES.invalidInput, "Invalid input", 400, error.message), issues: error.issues };
    case "Unauthenticated":
      return problem(PROBLEM_TYPES.unauthenticated, "Authentication required", 401, error.message);
    case "Forbidden":
      return problem(PROBLEM_TYPES.forbidden, "Forbidden", 403, error.message);
    case "RequestInProgress":
      return problem(PROBLEM_TYPES.requestInProgress, "A request with this idempotency key is in progress", 409);
    case "IdempotencyKeyReused":
      return problem(PROBLEM_TYPES.idempotencyKeyReused, "Idempotency key reused for a different request", 422);
    case "ConcurrencyConflict":
      return problem(PROBLEM_TYPES.concurrencyConflict, "Concurrent modification, retry the request", 409);
    case "DependencyUnavailable":
      return problem(PROBLEM_TYPES.dependencyUnavailable, "Service temporarily unavailable", 503);
    case "DependencyFailure":
      return problem(PROBLEM_TYPES.dependencyFailure, "A dependency failed", 502);
    case "OperationDefect":
      // Defects are bugs: say nothing about internals.
      return problem(PROBLEM_TYPES.internalError, "Internal error", 500);
  }
}

/** The protocol-level response for an operator task that did not run to completion. */
export function problemForOperateError(error: OperateError): Problem {
  return error._tag === "UnknownTask"
    ? problem(PROBLEM_TYPES.unknownTask, "Unknown operator task", 404, error.message)
    : problemForDispatchError(error);
}
