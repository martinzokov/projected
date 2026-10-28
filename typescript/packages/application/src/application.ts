import { Result, isPanic, isTaggedError, panic, type BusinessError } from "@projected/domain";
import type {
  Access,
  AnyContracts,
  AnyOperationContract,
  ErrorOf,
  InputOf,
  OperationsOf,
  OutputOf,
  RequestOf,
} from "./contract.js";
import {
  Forbidden,
  IdempotencyKeyReused,
  InvalidInput,
  OperationDefect,
  RequestInProgress,
  Unauthenticated,
  UnknownOperation,
  isInfrastructureError,
  type DispatchError,
  type InfrastructureError,
} from "./errors.js";
import { catchUp, type CatchUpReport, type EventHandler } from "./event-handler.js";
import { canonicalJson, sha256 } from "./fingerprint.js";
import type {
  CheckpointStore,
  EventLog,
  ExecutionContext,
  IdGenerator,
  IdempotencyStore,
  Metadata,
  Principal,
  ReadinessCheck,
} from "./ports.js";
import { currentTrace, noTelemetry, type Span, type Telemetry } from "./telemetry.js";
import { decodeWireError, encodeWireError, toValidationIssues, type OperationRequest, type OperationResult } from "./wire.js";

type MaybePromise<T> = T | Promise<T>;

/** Structural, so it also recognises Results from another copy of better-result. */
const isResult = (value: unknown): value is Result<unknown, unknown> =>
  typeof value === "object" &&
  value !== null &&
  "status" in value &&
  (value.status === "ok" || value.status === "error") &&
  typeof (value as { isOk?: unknown }).isOk === "function";

/**
 * Handles one operation. Returns the contract's output, one of its declared business errors, or
 * an infrastructure error. Returning any other error does not compile.
 */
export type Handler<C extends AnyOperationContract> = (
  input: InputOf<C>,
  context: ExecutionContext,
) => MaybePromise<Result<OutputOf<C>, ErrorOf<C> | InfrastructureError>>;

export type CommandHandler<C extends AnyOperationContract & { readonly kind: "command" }> = Handler<C>;
export type QueryHandler<C extends AnyOperationContract & { readonly kind: "query" }> = Handler<C>;

/** One handler per contract, keyed by `type@version`. Missing or extra keys are compile errors. */
export type HandlerMap<Operations extends readonly AnyOperationContract[]> = {
  readonly [Key in Operations[number]["key"]]: Handler<Extract<Operations[number], { readonly key: Key }>>;
};

/** `commands`/`queries` may be omitted only when the contracts have none. */
type HandlerOptions<C extends AnyContracts> = ({} extends HandlerMap<C["commands"]>
  ? { readonly commands?: HandlerMap<C["commands"]> }
  : { readonly commands: HandlerMap<C["commands"]> }) &
  ({} extends HandlerMap<C["queries"]>
    ? { readonly queries?: HandlerMap<C["queries"]> }
    : { readonly queries: HandlerMap<C["queries"]> });

export interface EventHandlingOptions {
  readonly handlers: readonly EventHandler[];
  /** Where handlers read events from: the flavour's event store or state store. */
  readonly store: EventLog;
  readonly checkpoints: CheckpointStore;
  /**
   * Catch handlers up after every successful command, before responding. Gives
   * read-your-writes consistency at the cost of latency; turn it off when a background
   * poller (`@projected/runtime`) runs them instead. Defaults to true.
   */
  readonly inline?: boolean;
}

export interface IdempotencyOptions {
  readonly store: IdempotencyStore;
  /** How long a claimed key stays locked while its command runs. Defaults to 60 s. */
  readonly lockMs?: number;
  /** How long a completed outcome is remembered. Defaults to 24 h. */
  readonly ttlMs?: number;
}

export type ApplicationOptions<C extends AnyContracts> = HandlerOptions<C> & {
  /** Generates message ids for requests that arrive without one. */
  readonly ids: IdGenerator;
  readonly eventHandling?: EventHandlingOptions;
  /**
   * Duplicate command protection. Commands that carry an idempotency key — the
   * `Idempotency-Key` header, or the message id of a queued command — run at most once per key;
   * repeats get the stored outcome.
   */
  readonly idempotency?: IdempotencyOptions;
  /** Tracing. Defaults to {@link noTelemetry}. Transports use the same instance. */
  readonly telemetry?: Telemetry;
  /** Called for every defect, before it is turned into an opaque error. Wire your logger here. */
  readonly onDefect?: (defect: OperationDefect) => void;
  /** Called when an inline catch-up fails. The command itself has already succeeded. */
  readonly onEventHandlingError?: (error: InfrastructureError) => void;
  /** What the service cannot serve without, asked by {@link Application.health}. */
  readonly readiness?: readonly ReadinessCheck[];
};

/** Whether the service should be sent traffic, and why not. */
export interface HealthReport {
  /** `ready` when every check passes; `draining` once {@link Application.drain} was called. */
  readonly status: "ready" | "unready" | "draining";
  readonly checks: ReadonlyArray<{ readonly name: string; readonly status: "up" | "down"; readonly message?: string }>;
}

/** How far one event handler is behind the log it reads. */
export interface EventHandlerBacklog {
  readonly handler: string;
  /** The global position it has processed up to. */
  readonly position: number;
  /** The oldest event it has yet to process — absent when it is caught up. */
  readonly oldestPending?: { readonly globalPosition: number; readonly recordedAt: string };
}

/** A service: contracts bound to handlers, callable from any transport. */
export interface Application<C extends AnyContracts = AnyContracts> {
  readonly contracts: C;
  readonly telemetry: Telemetry;
  /** Run an operation from untyped input, as transports do. */
  dispatch(request: OperationRequest): Promise<Result<OperationResult, DispatchError>>;
  /** Run an operation with typed input and output, through the same path as {@link dispatch}. */
  execute<Op extends OperationsOf<C>>(
    contract: Op,
    input: RequestOf<Op>,
    metadata?: Partial<Metadata>,
  ): Promise<Result<OutputOf<Op>, ErrorOf<Op> | DispatchError>>;
  /** Feed every event handler the events recorded since its checkpoint. */
  catchUp(): Promise<Result<readonly CatchUpReport[], InfrastructureError>>;
  /** Ask every readiness check; `draining` from the moment {@link drain} is called. */
  health(): Promise<HealthReport>;
  /**
   * Stop reporting ready, then wait for every operation and catch-up in flight to finish. Call it
   * first when shutting down, before closing servers and consumers (`shutdownGracefully` in
   * `@projected/runtime` does it in order).
   */
  drain(): Promise<void>;
  /** For each event handler, its checkpoint and the oldest event it has not processed yet. */
  backlog(): Promise<Result<readonly EventHandlerBacklog[], InfrastructureError>>;
}

/** Why a principal may not run an operation under `access`, or `undefined` when it may. */
export function checkAccess(
  operation: string,
  access: Access,
  principal: Principal | undefined,
): Unauthenticated | Forbidden | undefined {
  if (access === "public") return undefined;
  if (principal === undefined) {
    return new Unauthenticated({ operation, message: `${operation} requires an authenticated caller` });
  }
  if (access === "authenticated") return undefined;
  const missing = access.permissions.filter((permission) => !principal.permissions.includes(permission));
  if (missing.length === 0) return undefined;
  return new Forbidden({ operation, missing, message: `${operation} requires ${missing.join(", ")}` });
}

/**
 * Why something went wrong, for the defect's message. Combinators wrap a panic in their own
 * ("mapError callback threw"), so the reason worth reading is the deepest panic in the cause
 * chain — or, when nothing panicked, the deepest error.
 */
function rootReason(cause: unknown): string | undefined {
  let deepestPanic: string | undefined;
  let deepest: string | undefined;
  for (let current = cause, depth = 0; current instanceof Error && depth < 10; current = current.cause, depth++) {
    deepest = current.message;
    if (isPanic(current)) deepestPanic = current.message;
  }
  return deepestPanic ?? deepest;
}

/**
 * Bind contracts to handlers. This is the only place handlers are registered, and it lives in
 * the composition root (`src/infrastructure/config`).
 *
 * ```ts
 * const app = createApplication(schoolContracts, {
 *   ids,
 *   commands: { "enlist-student@1": enlistStudent({ students, ids }) },
 *   queries: { "enlisted-students-on-joining-date@1": enlistedStudentsOnJoiningDate({ directory }) },
 * });
 * ```
 */
export function createApplication<C extends AnyContracts>(contracts: C, options: ApplicationOptions<C>): Application<C> {
  const telemetry = options.telemetry ?? noTelemetry;
  const handlers = new Map<string, Handler<AnyOperationContract>>();
  const register = (kind: string, map: object | undefined, operations: readonly AnyOperationContract[]) => {
    const entries = (map ?? {}) as Record<string, Handler<AnyOperationContract>>;
    for (const contract of operations) {
      const handler = entries[contract.key];
      if (typeof handler !== "function") panic(`createApplication: no handler for ${kind} ${contract.key}`);
      handlers.set(`${contract.kind}:${contract.key}`, handler);
    }
    const known = new Set<string>(operations.map((contract) => contract.key));
    const extra = Object.keys(entries).filter((key) => !known.has(key));
    if (extra.length > 0) panic(`createApplication: handlers for unknown ${kind}s: ${extra.join(", ")}`);
  };
  register("command", options.commands, contracts.commands);
  register("query", options.queries, contracts.queries);

  const eventHandling = options.eventHandling;
  let catchUpQueue: Promise<unknown> = Promise.resolve();
  const runCatchUp = (): Promise<Result<readonly CatchUpReport[], InfrastructureError>> => {
    // Serialized so that concurrent requests never feed the same events to a handler twice.
    const run = catchUpQueue.then(async () => {
      if (eventHandling === undefined) return Result.ok([]);
      const reports: CatchUpReport[] = [];
      for (const handler of eventHandling.handlers) {
        const report = await catchUp(handler, eventHandling.store, eventHandling.checkpoints, { telemetry });
        if (report.isErr()) return Result.err(report.error);
        if (report.value.handled > 0) telemetry.count("projected.events.handled", report.value.handled, { "projected.event_handler": handler.name });
        reports.push(report.value);
      }
      return Result.ok(reports);
    });
    catchUpQueue = run.catch(() => undefined);
    return run;
  };

  const defect = (contract: AnyOperationContract, message: string, cause?: unknown): Result<never, OperationDefect> => {
    const reason = rootReason(cause);
    const full = reason === undefined || reason === message ? message : `${message}: ${reason}`;
    const error = new OperationDefect({ operation: `${contract.kind} ${contract.key}`, message: full, cause });
    options.onDefect?.(error);
    return Result.err(error);
  };

  const completeMetadata = (given: Partial<Metadata> | undefined): Metadata => {
    const messageId = given?.messageId ?? options.ids.next();
    const trace = currentTrace(telemetry);
    return {
      messageId,
      correlationId: given?.correlationId ?? messageId,
      causationId: given?.causationId,
      idempotencyKey: given?.idempotencyKey,
      ...(given?.principal === undefined ? {} : { principal: given.principal }),
      ...(trace === undefined ? {} : { trace }),
    };
  };

  /** Run the handler and classify its outcome. */
  const run = async (
    contract: AnyOperationContract,
    handler: Handler<AnyOperationContract>,
    input: unknown,
    metadata: Metadata,
  ): Promise<Result<OperationResult, DispatchError>> => {
    let outcome: unknown;
    try {
      outcome = await handler(input, { metadata });
    } catch (cause) {
      return defect(contract, "handler threw", cause);
    }
    if (!isResult(outcome)) return defect(contract, "handler did not return a Result", outcome);

    if (outcome.isOk()) {
      const output = contract.output.safeParse(outcome.value);
      if (!output.success) return defect(contract, "handler output does not match the contract", output.error);
      if (contract.kind === "command" && eventHandling !== undefined && eventHandling.inline !== false) {
        const caughtUp = await runCatchUp();
        if (caughtUp.isErr()) options.onEventHandlingError?.(caughtUp.error);
      }
      return Result.ok({ status: "ok", value: output.data });
    }
    const error = outcome.error;
    if (isInfrastructureError(error)) return Result.err(error);
    const wire = isTaggedError(error) ? encodeWireError(contract, error as BusinessError) : undefined;
    if (wire === undefined) return defect(contract, "handler returned an error its contract does not declare", error);
    return Result.ok({ status: "error", error: wire });
  };

  /** Run a command at most once per idempotency key, replaying the stored outcome for repeats. */
  const runOnce = async (
    idempotency: IdempotencyOptions,
    key: string,
    contract: AnyOperationContract,
    input: unknown,
    metadata: Metadata,
    span: Span,
  ): Promise<Result<OperationResult, DispatchError>> => {
    const handler = handlers.get(`${contract.kind}:${contract.key}`) as Handler<AnyOperationContract>;
    // Keys are scoped to the caller, so one principal can never replay another's outcome.
    const scoped = `${contracts.name}:${metadata.principal?.id ?? "anonymous"}:${key}`;
    const fingerprint = sha256(canonicalJson({ kind: contract.kind, operation: contract.key, input }));
    const claim = await idempotency.store.claim(scoped, fingerprint, {
      lockMs: idempotency.lockMs ?? 60_000,
      ttlMs: idempotency.ttlMs ?? 24 * 60 * 60 * 1000,
    });
    if (claim.isErr()) return Result.err(claim.error);
    const state = claim.value;
    if (state.status !== "claimed" && state.fingerprint !== fingerprint) {
      return Result.err(
        new IdempotencyKeyReused({ idempotencyKey: key, message: `Idempotency key ${key} was used for a different request` }),
      );
    }
    if (state.status === "completed") {
      span.setAttributes({ "projected.idempotency": "replayed" });
      return Result.ok(state.result);
    }
    if (state.status === "in-progress") {
      return Result.err(new RequestInProgress({ idempotencyKey: key, message: `A request with key ${key} is still running` }));
    }

    span.setAttributes({ "projected.idempotency": "first" });
    const outcome = await run(contract, handler, input, metadata);
    // Business outcomes are final and remembered; anything else may succeed on a retry.
    const settled = outcome.isOk()
      ? await idempotency.store.complete(scoped, outcome.value)
      : await idempotency.store.release(scoped);
    // The command ran either way, so the caller still gets its outcome. An unrecorded outcome
    // only matters if this exact request is retried after the lock expires — make that visible.
    if (settled.isErr()) span.fail(`could not record the idempotent outcome: ${settled.error.message}`);
    return outcome;
  };

  // Work in flight, for drain() to wait on.
  const inFlight = new Set<Promise<unknown>>();
  let draining = false;
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
    return work;
  };

  const health = async (): Promise<HealthReport> => {
    const checks = await Promise.all(
      (options.readiness ?? []).map(async (readiness) => {
        const outcome = await readiness.check().catch((cause: unknown) => Result.err({ message: `check threw: ${String(cause)}` }));
        return outcome.isOk()
          ? { name: readiness.name, status: "up" as const }
          : { name: readiness.name, status: "down" as const, message: outcome.error.message };
      }),
    );
    const status = draining ? "draining" : checks.every((check) => check.status === "up") ? "ready" : "unready";
    return { status, checks };
  };

  const drain = async (): Promise<void> => {
    draining = true;
    // Work started while waiting is waited for too.
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    await catchUpQueue;
  };

  const backlog = async (): Promise<Result<readonly EventHandlerBacklog[], InfrastructureError>> => {
    if (eventHandling === undefined) return Result.ok([]);
    const backlogs: EventHandlerBacklog[] = [];
    for (const handler of eventHandling.handlers) {
      const position = await eventHandling.checkpoints.load(handler.name);
      if (position.isErr()) return Result.err(position.error);
      const next = await eventHandling.store.readAll({ after: position.value, limit: 1 });
      if (next.isErr()) return Result.err(next.error);
      const pending = next.value[0];
      backlogs.push({
        handler: handler.name,
        position: position.value,
        ...(pending === undefined ? {} : { oldestPending: { globalPosition: pending.globalPosition, recordedAt: pending.recordedAt } }),
      });
    }
    return Result.ok(backlogs);
  };

  const dispatch = (request: OperationRequest): Promise<Result<OperationResult, DispatchError>> => {
    const contract = contracts.find(request.kind, request.type, request.version);
    const handler = contract && handlers.get(`${contract.kind}:${contract.key}`);
    if (contract === undefined || handler === undefined) {
      return Promise.resolve(
        Result.err(
          new UnknownOperation({
            kind: request.kind,
            type: request.type,
            version: request.version,
            message: `No ${request.kind} ${request.type} at version ${request.version}`,
          }),
        ),
      );
    }
    const operation = `${contract.kind} ${contract.key}`;
    return telemetry.span(
      operation,
      {
        kind: "internal",
        attributes: {
          "projected.service": contracts.name,
          "projected.operation.kind": contract.kind,
          "projected.operation.type": contract.type,
          "projected.operation.version": contract.version,
          "projected.message_id": request.metadata?.messageId,
          "projected.correlation_id": request.metadata?.correlationId,
          "enduser.id": request.metadata?.principal?.id,
        },
      },
      async (span) => {
        const outcome = await (async (): Promise<Result<OperationResult, DispatchError>> => {
          // Access before validation: callers who may not run an operation learn nothing about its input.
          const denied = checkAccess(operation, contracts.accessOf(contract), request.metadata?.principal);
          if (denied !== undefined) return Result.err(denied);

          const input = contract.input.safeParse(request.input);
          if (!input.success) {
            return Result.err(
              new InvalidInput({ issues: toValidationIssues(input.error.issues), message: `Invalid input for ${operation}` }),
            );
          }
          const metadata = completeMetadata(request.metadata);
          const key = metadata.idempotencyKey;
          if (contract.kind === "command" && key !== undefined && options.idempotency !== undefined) {
            return runOnce(options.idempotency, key, contract, input.data, metadata, span);
          }
          return run(contract, handler, input.data, metadata);
        })();

        const result = outcome.match<{ outcome: string; errorType: string | undefined }>({
          ok: (value) => ({ outcome: value.status, errorType: value.status === "error" ? value.error.type : undefined }),
          err: (error) => {
            span.fail(error.message);
            return { outcome: "failed", errorType: error._tag };
          },
        });
        span.setAttributes({ "projected.outcome": result.outcome, "projected.error.type": result.errorType });
        telemetry.count("projected.operations", 1, {
          "projected.service": contracts.name,
          "projected.operation.kind": contract.kind,
          "projected.operation.type": contract.type,
          "projected.operation.version": contract.version,
          "projected.outcome": result.outcome,
          "projected.error.type": result.errorType,
        });
        return outcome;
      },
    );
  };

  return {
    contracts,
    telemetry,
    dispatch: (request) => track(dispatch(request)),
    execute: async (contract, input, metadata) => {
      const { kind, type, version } = contract as AnyOperationContract;
      const dispatched = await track(dispatch({ kind, type, version, input, ...(metadata === undefined ? {} : { metadata }) }));
      if (dispatched.isErr()) return Result.err(dispatched.error);
      const result = dispatched.value;
      if (result.status === "ok") return Result.ok(result.value as OutputOf<typeof contract>);
      const error = decodeWireError(contract, result.error);
      return error === undefined ? defect(contract, `cannot decode error ${result.error.type}`) : Result.err(error);
    },
    catchUp: () => track(runCatchUp()),
    health,
    drain,
    backlog,
  };
}
