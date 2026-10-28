import { Result, isTaggedError, panic, type BusinessError } from "@projected/domain";
import { checkAccess } from "./access.js";
import type { AnyContracts, AnyOperationContract, ErrorOf, InputOf, OperationsOf, OutputOf, RequestOf } from "./contract.js";
import {
  InvalidInput,
  OperationDefect,
  UnknownOperation,
  defectReason,
  isInfrastructureError,
  type DispatchError,
  type InfrastructureError,
  type OperateError,
} from "./errors.js";
import type { CatchUpReport, EventHandlingError } from "./event-handler.js";
import { eventHandling, type EventHandlerBacklog, type EventHandlingOptions } from "./event-handling.js";
import { oncePerKey, type IdempotencyOptions } from "./idempotency.js";
import { lifecycle, type HealthReport } from "./lifecycle.js";
import type { MaybePromise } from "./naming.js";
import type { OperatorTask } from "./operator.js";
import { operatorTasks } from "./operator-tasks.js";
import type { ExecutionContext, IdGenerator, Metadata, ReadinessCheck } from "./ports.js";
import { currentTrace, noTelemetry, type Telemetry } from "./telemetry.js";
import { decodeWireError, encodeWireError, toValidationIssues, type OperationRequest, type OperationResult } from "./wire.js";

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
  /**
   * Called for every defect — an operation, task or event handler that threw or broke its
   * contract — before it is turned into an opaque error. Wire your logger here.
   */
  readonly onDefect?: (defect: OperationDefect) => void;
  /**
   * Called for each event handler an inline catch-up could not bring up to date, with its name.
   * The command has succeeded either way; the handler resumes at the failed event next time.
   * Defects go to {@link onDefect} instead.
   */
  readonly onEventHandlingError?: (error: InfrastructureError, handler: string) => void;
  /** What the service cannot serve without, asked by {@link Application.health}. */
  readonly readiness?: readonly ReadinessCheck[];
  /**
   * Maintenance tasks beyond the built-in `list-tasks`, `backlog` and `rebuild` — e.g.
   * `deadLetterReplay(transport, ...)` from `@projected/messaging`. Run with {@link Application.operate}.
   */
  readonly operatorTasks?: readonly OperatorTask[];
};

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
  /**
   * Feed every event handler the events recorded since its checkpoint. Every handler gets its
   * turn even when another fails; the first failure is returned.
   */
  catchUp(): Promise<Result<readonly CatchUpReport[], EventHandlingError>>;
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
  /**
   * Run an operator task — `list-tasks`, `backlog`, `rebuild` or one from `operatorTasks` — for a
   * principal holding the `projected:operate` permission. Transports call it (`POST /operate/{name}`).
   */
  operate(task: string, input: unknown, metadata?: Partial<Metadata>): Promise<Result<unknown, OperateError>>;
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

  const events = eventHandling(options.eventHandling, {
    telemetry,
    onDefect: options.onDefect,
    onEventHandlingError: options.onEventHandlingError,
  });
  const runOnce = options.idempotency === undefined ? undefined : oncePerKey(options.idempotency, contracts.name);

  const defect = (contract: AnyOperationContract, message: string, cause?: unknown): Result<never, OperationDefect> => {
    const reason = defectReason(cause);
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
      // Failures are reported as they happen; the command has succeeded either way.
      if (contract.kind === "command") await events.afterCommand();
      return Result.ok({ status: "ok", value: output.data });
    }
    const error = outcome.error;
    if (isInfrastructureError(error)) return Result.err(error);
    const wire = isTaggedError(error) ? encodeWireError(contract, error as BusinessError) : undefined;
    if (wire === undefined) return defect(contract, "handler returned an error its contract does not declare", error);
    return Result.ok({ status: "error", error: wire });
  };

  const { track, health, drain } = lifecycle(options.readiness ?? [], events.idle);
  const operate = operatorTasks({
    service: contracts.name,
    telemetry,
    events,
    tasks: options.operatorTasks ?? [],
    metadata: completeMetadata,
    onDefect: options.onDefect,
  });

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
    // Ids first, so the span names the message even when the transport sent none.
    const messageId = request.metadata?.messageId ?? options.ids.next();
    const given: Partial<Metadata> = { ...request.metadata, messageId };
    return telemetry.span(
      operation,
      {
        kind: "internal",
        attributes: {
          "projected.service": contracts.name,
          "projected.operation.kind": contract.kind,
          "projected.operation.type": contract.type,
          "projected.operation.version": contract.version,
          "projected.message_id": messageId,
          "projected.correlation_id": request.metadata?.correlationId ?? messageId,
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
          const metadata = completeMetadata(given);
          const key = metadata.idempotencyKey;
          const once = () => run(contract, handler, input.data, metadata);
          if (contract.kind === "command" && key !== undefined && runOnce !== undefined) {
            return runOnce({ key, contract, input: input.data, metadata }, span, once);
          }
          return once();
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
    catchUp: () => track(events.catchUp()),
    health,
    drain,
    backlog: events.backlog,
    operate: (task, input, metadata) => track(operate(task, input, metadata)),
  };
}
