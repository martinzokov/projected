import { TaggedError } from "@projected/domain";

/**
 * Infrastructure errors: failures of the machinery around the business logic, not of a business
 * rule. Handlers may return them without declaring them in a contract. Transports map them to
 * protocol-level responses (HTTP 409/502/503, message redelivery) — never to a business outcome.
 */

/** Someone else wrote to the aggregate between our read and our write. Safe to retry. */
export class ConcurrencyConflict extends TaggedError("ConcurrencyConflict")<{
  /** Storage key of the aggregate: its stream, when event-sourced. */
  key: string;
  expectedVersion: number | "any";
  actualVersion: number;
  message: string;
}> {}

/** A dependency (database, broker, remote service) could not be reached. Retryable. */
export class DependencyUnavailable extends TaggedError("DependencyUnavailable")<{
  dependency: string;
  message: string;
  cause?: unknown;
}> {}

/** A dependency answered, but not in a way the contract allows. Not retryable without a fix. */
export class DependencyFailure extends TaggedError("DependencyFailure")<{
  dependency: string;
  message: string;
  cause?: unknown;
}> {}

export type InfrastructureError = ConcurrencyConflict | DependencyUnavailable | DependencyFailure;

export function isInfrastructureError(value: unknown): value is InfrastructureError {
  return ConcurrencyConflict.is(value) || DependencyUnavailable.is(value) || DependencyFailure.is(value);
}

/**
 * Dispatch errors: the request never reached a business outcome. Together with
 * {@link InfrastructureError} they are what a transport turns into a protocol-level response.
 */

/** No contract matches the requested kind, type and version. */
export class UnknownOperation extends TaggedError("UnknownOperation")<{
  kind: string;
  type: string;
  version: number;
  message: string;
}> {}

/** A single validation problem, transport-neutral. */
export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly code: string | undefined;
}

/** The request body does not match the contract's input schema. */
export class InvalidInput extends TaggedError("InvalidInput")<{
  issues: readonly ValidationIssue[];
  message: string;
}> {}

/**
 * A bug: the handler threw, returned an error its contract does not declare, or returned output
 * that does not match the contract. Never shown to callers in detail.
 */
export class OperationDefect extends TaggedError("OperationDefect")<{
  operation: string;
  message: string;
  cause?: unknown;
}> {}

/** The operation is not public and the request carries no (valid) credentials. */
export class Unauthenticated extends TaggedError("Unauthenticated")<{
  operation: string;
  message: string;
}> {}

/** The principal is known but lacks a permission the operation requires. */
export class Forbidden extends TaggedError("Forbidden")<{
  operation: string;
  missing: readonly string[];
  message: string;
}> {}

/** A command with the same idempotency key is being processed right now. Retry later. */
export class RequestInProgress extends TaggedError("RequestInProgress")<{
  idempotencyKey: string;
  message: string;
}> {}

/** The idempotency key was already used for a different request. Use a new key. */
export class IdempotencyKeyReused extends TaggedError("IdempotencyKeyReused")<{
  idempotencyKey: string;
  message: string;
}> {}

export type AccessError = Unauthenticated | Forbidden;
export type IdempotencyError = RequestInProgress | IdempotencyKeyReused;

export type DispatchError =
  | UnknownOperation
  | InvalidInput
  | OperationDefect
  | AccessError
  | IdempotencyError
  | InfrastructureError;

export function isDispatchError(value: unknown): value is DispatchError {
  return (
    UnknownOperation.is(value) ||
    InvalidInput.is(value) ||
    OperationDefect.is(value) ||
    Unauthenticated.is(value) ||
    Forbidden.is(value) ||
    RequestInProgress.is(value) ||
    IdempotencyKeyReused.is(value) ||
    isInfrastructureError(value)
  );
}
