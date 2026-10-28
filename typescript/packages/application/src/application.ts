import { Result, isTaggedError, panic, z, type BusinessError } from "@projected/domain";
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
  defectReason,
  RequestInProgress,
  Unauthenticated,
  UnknownOperation,
  UnknownTask,
  isInfrastructureError,
  type DispatchError,
  type InfrastructureError,
  type OperateError,
} from "./errors.js";
import { catchUp, type CatchUpReport, type EventHandler, type EventHandlingError } from "./event-handler.js";
import { canonicalJson, sha256 } from "./fingerprint.js";
import { OPERATE, defineOperatorTask, type OperatorTask } from "./operator.js";
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
import type { MaybePromise } from "./naming.js";

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
   * Which handlers catch up after every successful command, before it responds: all of them
   * (`true`, the default), none (`false`), or those named. Inline gives read-your-writes
   * consistency at the cost of latency, so keep it to read models a caller reads right after
   * writing; relays to a broker belong to a background poller (`startPolling` from
   * `@projected/runtime`), which runs every handler and picks up whatever an inline run left.
   */
  readonly inline?: boolean | readonly string[];
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
 * Keys are scoped to the caller, but every anonymous caller is the same caller: their keys must
 * be too long to guess, or one could replay another's outcome.
 */
const MIN_ANONYMOUS_KEY_LENGTH = 16;

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
  const allHandlers = eventHandling?.handlers ?? [];
  const inline = eventHandling?.inline ?? true;
  if (typeof inline !== "boolean") {
    const unknown = inline.filter((name) => !allHandlers.some((handler) => handler.name === name));
    if (unknown.length > 0) panic(`createApplication: eventHandling.inline names no event handler: ${unknown.join(", ")}`);
  }
  const inlineHandlers = inline === true ? allHandlers : inline === false ? [] : allHandlers.filter((handler) => inline.includes(handler.name));

  /** A handler that stopped: counted, and a defect reported like any other. */
  const handlerFailed = (handler: EventHandler, error: EventHandlingError) => {
    telemetry.count("projected.event_handler.failures", 1, { "projected.event_handler": handler.name, "projected.error.type": error._tag });
    if (OperationDefect.is(error)) options.onDefect?.(error);
  };
  /** Catch one handler up. A store that throws is a defect, not a rejection. */
  const catchUpOne = (handler: EventHandler, store: EventLog, checkpoints: CheckpointStore) =>
    catchUp(handler, store, checkpoints, { telemetry }).catch((cause: unknown) => {
      const reason = defectReason(cause);
      return Result.err(
        new OperationDefect({ operation: `event-handler ${handler.name}`, message: `catch-up threw${reason === undefined ? "" : `: ${reason}`}`, cause }),
      );
    });

  let catchUpQueue: Promise<unknown> = Promise.resolve();
  const runCatchUp = (
    handlers: readonly EventHandler[],
    onFailure?: (handler: EventHandler, error: EventHandlingError) => void,
  ): Promise<Result<readonly CatchUpReport[], EventHandlingError>> => {
    // Serialized so that concurrent requests never feed the same events to a handler twice.
    const run = catchUpQueue.then(async (): Promise<Result<readonly CatchUpReport[], EventHandlingError>> => {
      if (eventHandling === undefined) return Result.ok([]);
      const reports: CatchUpReport[] = [];
      let failure: EventHandlingError | undefined;
      // Every handler gets its turn: a broken read model must not hold back a relay.
      for (const handler of handlers) {
        const report = await catchUpOne(handler, eventHandling.store, eventHandling.checkpoints);
        if (report.isErr()) {
          handlerFailed(handler, report.error);
          onFailure?.(handler, report.error);
          failure ??= report.error;
          continue;
        }
        if (report.value.handled > 0) telemetry.count("projected.events.handled", report.value.handled, { "projected.event_handler": handler.name });
        reports.push(report.value);
      }
      return failure === undefined ? Result.ok(reports) : Result.err(failure);
    });
    catchUpQueue = run.catch(() => undefined);
    return run;
  };
  const inlineFailed = (handler: EventHandler, error: EventHandlingError) => {
    if (!OperationDefect.is(error)) options.onEventHandlingError?.(error, handler.name);
  };

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
      if (contract.kind === "command" && inlineHandlers.length > 0) await runCatchUp(inlineHandlers, inlineFailed);
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
    // Both callbacks, not `finally`: a derived promise that rejects again would go unhandled
    // and end the process, even though the caller handles `work` itself.
    const settled = () => inFlight.delete(work);
    void work.then(settled, settled);
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

  const noSuchHandler = (name: string) => {
    const names = eventHandling?.handlers.map((handler) => handler.name) ?? [];
    const message =
      names.length === 0 ? "This service has no event handlers" : `No event handler ${name}; there are: ${names.join(", ")}`;
    return new InvalidInput({ issues: [{ path: ["handler"], message, code: undefined }], message });
  };

  const builtInTasks: OperatorTask[] = [
    defineOperatorTask({
      name: "list-tasks",
      description: "The operator tasks this service offers, with the input each takes.",
      input: z.object({}),
      run: () =>
        Result.ok({
          tasks: [...tasks.values()].map((task) => ({
            name: task.name,
            description: task.description,
            input: z.toJSONSchema(task.input, { io: "input", unrepresentable: "any" }),
          })),
        }),
    }),
    defineOperatorTask({
      name: "backlog",
      description: "Each event handler's checkpoint, and the oldest event it has yet to process.",
      input: z.object({}),
      run: async () => (await backlog()).map((handlers) => ({ handlers })),
    }),
    defineOperatorTask({
      name: "rebuild",
      description:
        "Replay every event to one event handler from the start, after its reset if it has one: rebuilds a read model. " +
        "Stop the other instances' event handling first, so none moves the checkpoint meanwhile.",
      input: z.object({ handler: z.string() }),
      run: async ({ handler: name }) => {
        const handler = eventHandling?.handlers.find((candidate) => candidate.name === name);
        if (eventHandling === undefined || handler === undefined) return Result.err(noSuchHandler(name));
        // In the catch-up queue, so no catch-up in this process reads the checkpoint mid-reset.
        const rebuilt = catchUpQueue.then(async (): Promise<Result<CatchUpReport, EventHandlingError>> => {
          if (handler.reset !== undefined) {
            const reset = await handler.reset();
            if (reset.isErr()) return Result.err(reset.error);
          }
          const rewound = await eventHandling.checkpoints.save(handler.name, 0);
          if (rewound.isErr()) return Result.err(rewound.error);
          const report = await catchUpOne(handler, eventHandling.store, eventHandling.checkpoints);
          if (report.isErr()) handlerFailed(handler, report.error);
          return report;
        });
        catchUpQueue = rebuilt.catch(() => undefined);
        return rebuilt;
      },
    }),
  ];
  const tasks = new Map<string, OperatorTask>();
  for (const task of [...builtInTasks, ...(options.operatorTasks ?? [])]) {
    if (tasks.has(task.name)) panic(`createApplication: two operator tasks are named ${task.name}`);
    tasks.set(task.name, task);
  }

  const operate = async (name: string, input: unknown, given?: Partial<Metadata>): Promise<Result<unknown, OperateError>> => {
    const task = tasks.get(name);
    if (task === undefined) return Result.err(new UnknownTask({ task: name, message: `No operator task ${name}; list-tasks names the ones there are` }));
    const operation = `task ${name}`;
    return telemetry.span(
      operation,
      { kind: "internal", attributes: { "projected.service": contracts.name, "projected.task": name, "enduser.id": given?.principal?.id } },
      async (span) => {
        const outcome = await (async (): Promise<Result<unknown, OperateError>> => {
          const denied = checkAccess(operation, { permissions: [OPERATE] }, given?.principal);
          if (denied !== undefined) return Result.err(denied);
          const parsed = task.input.safeParse(input);
          if (!parsed.success) {
            return Result.err(new InvalidInput({ issues: toValidationIssues(parsed.error.issues), message: `Invalid input for ${operation}` }));
          }
          try {
            return await task.run(parsed.data, { metadata: completeMetadata(given) });
          } catch (cause) {
            const reason = defectReason(cause);
            const error = new OperationDefect({ operation, message: `task threw${reason === undefined ? "" : `: ${reason}`}`, cause });
            options.onDefect?.(error);
            return Result.err(error);
          }
        })();
        const result = outcome.isOk() ? "ok" : "failed";
        if (outcome.isErr()) span.fail(outcome.error.message);
        span.setAttributes({ "projected.outcome": result, "projected.error.type": outcome.isErr() ? outcome.error._tag : undefined });
        telemetry.count("projected.operator_tasks", 1, {
          "projected.service": contracts.name,
          "projected.task": name,
          "projected.outcome": result,
          "projected.error.type": outcome.isErr() ? outcome.error._tag : undefined,
        });
        return outcome;
      },
    );
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
          if (contract.kind === "command" && key !== undefined && options.idempotency !== undefined) {
            // Anonymous callers share one scope, so the key itself must be what keeps their outcomes apart.
            if (metadata.principal === undefined && key.length < MIN_ANONYMOUS_KEY_LENGTH) {
              const message = `An anonymous caller's idempotency key must be at least ${MIN_ANONYMOUS_KEY_LENGTH} characters: send a random UUID`;
              return Result.err(new InvalidInput({ issues: [{ path: ["Idempotency-Key"], message, code: undefined }], message }));
            }
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
    catchUp: () => track(runCatchUp(allHandlers)),
    health,
    drain,
    backlog,
    operate: (task, input, metadata) => track(operate(task, input, metadata)),
  };
}
