import { isBusinessErrorClass, type BusinessError, type z } from "@projected/domain";
import type { AnyOperationContract, ErrorOf, OperationKind } from "./contract.js";
import type { ValidationIssue } from "./errors.js";
import type { Metadata } from "./ports.js";

/**
 * Transport-neutral wire formats, shared by every inbound and outbound adapter. The normative,
 * language-neutral description lives in `spec/protocol.md`.
 */

/** A request to run one operation, as it arrives from any transport. */
export interface OperationRequest {
  readonly kind: OperationKind;
  readonly type: string;
  readonly version: number;
  readonly input: unknown;
  readonly metadata?: Partial<Metadata>;
}

/** A business error on the wire. `type` is the error's tag; `data` matches its schema. */
export interface WireError {
  readonly type: string;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * The business outcome of an operation: it ran, and either succeeded or returned one of the
 * errors its contract declares. Both are a successful exchange at the protocol level.
 */
export type OperationResult<Value = unknown> =
  | { readonly status: "ok"; readonly value: Value }
  | { readonly status: "error"; readonly error: WireError };

/** Serialize a business error. Only data declared in the error's schema is sent. */
export function encodeWireError(contract: AnyOperationContract, error: BusinessError): WireError | undefined {
  const definition = contract.errors.find((candidate) => candidate.tag === error._tag);
  if (definition === undefined || !(error instanceof definition)) return undefined;
  const data = definition.schema.safeParse(error);
  if (!data.success) return undefined;
  return { type: error._tag, message: error.message, data: data.data };
}

/**
 * Rebuild a business error from the wire, as an instance of the contract's own error class.
 * Returns `undefined` when the error is not declared or its data does not match.
 */
export function decodeWireError<C extends AnyOperationContract>(contract: C, wire: unknown): ErrorOf<C> | undefined {
  if (typeof wire !== "object" || wire === null) return undefined;
  const { type, data } = wire as { type?: unknown; data?: unknown };
  const definition = contract.errors.find((candidate) => candidate.tag === type);
  if (definition === undefined || !isBusinessErrorClass(definition)) return undefined;
  const parsed = definition.schema.safeParse(data ?? {});
  if (!parsed.success) return undefined;
  return new definition(parsed.data) as ErrorOf<C>;
}

/** Convert schema issues to transport-neutral validation issues. */
export function toValidationIssues(issues: readonly z.core.$ZodIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
    message: issue.message,
    code: issue.code,
  }));
}
