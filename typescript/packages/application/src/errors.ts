import { TaggedError } from "@projected/domain";

/**
 * Infrastructure errors: failures of the machinery around the business logic, not of a business
 * rule. Handlers may return them without declaring them in a contract. Transports map them to
 * protocol-level responses (HTTP 409/502/503, message redelivery) — never to a business outcome.
 */

/** Someone else wrote to the stream between our read and our append. Safe to retry. */
export class ConcurrencyConflict extends TaggedError("ConcurrencyConflict")<{
  stream: string;
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

export type DispatchError = UnknownOperation | InvalidInput | OperationDefect | InfrastructureError;

export function isDispatchError(value: unknown): value is DispatchError {
  return UnknownOperation.is(value) || InvalidInput.is(value) || OperationDefect.is(value) || isInfrastructureError(value);
}
