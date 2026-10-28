import { Result } from "@projected/domain";
import type { AnyOperationContract } from "./contract.js";
import { IdempotencyKeyReused, InvalidInput, RequestInProgress, type DispatchError } from "./errors.js";
import { canonicalJson, sha256 } from "./fingerprint.js";
import type { IdempotencyStore, Metadata } from "./ports.js";
import type { Span } from "./telemetry.js";
import type { OperationResult } from "./wire.js";

export interface IdempotencyOptions {
  readonly store: IdempotencyStore;
  /** How long a claimed key stays locked while its command runs. Defaults to 60 s. */
  readonly lockMs?: number;
  /** How long a completed outcome is remembered. Defaults to 24 h. */
  readonly ttlMs?: number;
}

/**
 * Keys are scoped to the caller, but every anonymous caller is the same caller: their keys must
 * be too long to guess, or one could replay another's outcome.
 */
const MIN_ANONYMOUS_KEY_LENGTH = 16;

/** One command with its idempotency key, ready to run. */
export interface KeyedCommand {
  readonly key: string;
  readonly contract: AnyOperationContract;
  /** The validated input: what the fingerprint is taken of. */
  readonly input: unknown;
  readonly metadata: Metadata;
}

/**
 * Duplicate command protection for one service: run each command at most once per key and
 * caller, and replay the stored outcome to repeats (spec/protocol.md §2.2).
 */
export function oncePerKey(options: IdempotencyOptions, service: string) {
  const lockMs = options.lockMs ?? 60_000;
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;

  return async (
    { key, contract, input, metadata }: KeyedCommand,
    span: Span,
    run: () => Promise<Result<OperationResult, DispatchError>>,
  ): Promise<Result<OperationResult, DispatchError>> => {
    if (metadata.principal === undefined && key.length < MIN_ANONYMOUS_KEY_LENGTH) {
      const message = `An anonymous caller's idempotency key must be at least ${MIN_ANONYMOUS_KEY_LENGTH} characters: send a random UUID`;
      return Result.err(new InvalidInput({ issues: [{ path: ["Idempotency-Key"], message, code: undefined }], message }));
    }
    // Keys are scoped to the caller, so one principal can never replay another's outcome.
    const scoped = `${service}:${metadata.principal?.id ?? "anonymous"}:${key}`;
    const fingerprint = sha256(canonicalJson({ kind: contract.kind, operation: contract.key, input }));
    const claim = await options.store.claim(scoped, fingerprint, { lockMs, ttlMs });
    if (claim.isErr()) return Result.err(claim.error);
    const state = claim.value;
    if (state.status !== "claimed" && state.fingerprint !== fingerprint) {
      return Result.err(new IdempotencyKeyReused({ idempotencyKey: key, message: `Idempotency key ${key} was used for a different request` }));
    }
    if (state.status === "completed") {
      span.setAttributes({ "projected.idempotency": "replayed" });
      return Result.ok(state.result);
    }
    if (state.status === "in-progress") {
      return Result.err(new RequestInProgress({ idempotencyKey: key, message: `A request with key ${key} is still running` }));
    }

    span.setAttributes({ "projected.idempotency": "first" });
    const outcome = await run();
    // Business outcomes are final and remembered; anything else may succeed on a retry.
    const settled = outcome.isOk() ? await options.store.complete(scoped, outcome.value) : await options.store.release(scoped);
    // The command ran either way, so the caller still gets its outcome. An unrecorded outcome
    // only matters if this exact request is retried after the lock expires — make that visible.
    if (settled.isErr()) span.fail(`could not record the idempotent outcome: ${settled.error.message}`);
    return outcome;
  };
}
