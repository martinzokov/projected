import { Result, isTaggedError, panic, type BusinessError } from "@projected/domain";
import type {
  AnyContracts,
  AnyOperationContract,
  ErrorOf,
  InputOf,
  OperationsOf,
  OutputOf,
  RequestOf,
} from "./contract.js";
import {
  InvalidInput,
  OperationDefect,
  UnknownOperation,
  isInfrastructureError,
  type DispatchError,
  type InfrastructureError,
} from "./errors.js";
import { catchUp, type CatchUpReport, type EventHandler } from "./event-handler.js";
import type { CheckpointStore, EventStore, ExecutionContext, IdGenerator, Metadata } from "./ports.js";
import { decodeWireError, encodeWireError, toValidationIssues, type OperationRequest, type OperationResult } from "./wire.js";

type MaybePromise<T> = T | Promise<T>;

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
  readonly store: EventStore;
  readonly checkpoints: CheckpointStore;
  /**
   * Catch handlers up after every successful command, before responding. Gives
   * read-your-writes consistency at the cost of latency; turn it off when a background
   * poller (`@projected/runtime`) runs them instead. Defaults to true.
   */
  readonly inline?: boolean;
}

export type ApplicationOptions<C extends AnyContracts> = HandlerOptions<C> & {
  /** Generates message ids for requests that arrive without one. */
  readonly ids: IdGenerator;
  readonly eventHandling?: EventHandlingOptions;
  /** Called for every defect, before it is turned into an opaque error. Wire your logger here. */
  readonly onDefect?: (defect: OperationDefect) => void;
  /** Called when an inline catch-up fails. The command itself has already succeeded. */
  readonly onEventHandlingError?: (error: InfrastructureError) => void;
};

/** A service: contracts bound to handlers, callable from any transport. */
export interface Application<C extends AnyContracts = AnyContracts> {
  readonly contracts: C;
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
        const report = await catchUp(handler, eventHandling.store, eventHandling.checkpoints);
        if (report.isErr()) return Result.err(report.error);
        reports.push(report.value);
      }
      return Result.ok(reports);
    });
    catchUpQueue = run.catch(() => undefined);
    return run;
  };

  const defect = (contract: AnyOperationContract, message: string, cause?: unknown): Result<never, OperationDefect> => {
    const error = new OperationDefect({ operation: `${contract.kind} ${contract.key}`, message, cause });
    options.onDefect?.(error);
    return Result.err(error);
  };

  const completeMetadata = (given: Partial<Metadata> | undefined): Metadata => {
    const messageId = given?.messageId ?? options.ids.next();
    return {
      messageId,
      correlationId: given?.correlationId ?? messageId,
      causationId: given?.causationId,
      idempotencyKey: given?.idempotencyKey,
    };
  };

  const dispatch = async (request: OperationRequest): Promise<Result<OperationResult, DispatchError>> => {
    const contract = contracts.find(request.kind, request.type, request.version);
    const handler = contract && handlers.get(`${contract.kind}:${contract.key}`);
    if (contract === undefined || handler === undefined) {
      return Result.err(
        new UnknownOperation({
          kind: request.kind,
          type: request.type,
          version: request.version,
          message: `No ${request.kind} ${request.type} at version ${request.version}`,
        }),
      );
    }
    const input = contract.input.safeParse(request.input);
    if (!input.success) {
      return Result.err(
        new InvalidInput({
          issues: toValidationIssues(input.error.issues),
          message: `Invalid input for ${contract.kind} ${contract.key}`,
        }),
      );
    }

    let outcome: unknown;
    try {
      outcome = await handler(input.data, { metadata: completeMetadata(request.metadata) });
    } catch (cause) {
      return defect(contract, "handler threw", cause);
    }
    if (!Result.isOk(outcome as Result<unknown, unknown>) && !Result.isError(outcome as Result<unknown, unknown>)) {
      return defect(contract, "handler did not return a Result", outcome);
    }
    const result = outcome as Result<unknown, unknown>;

    if (result.isOk()) {
      const output = contract.output.safeParse(result.value);
      if (!output.success) return defect(contract, "handler output does not match the contract", output.error);
      if (contract.kind === "command" && eventHandling !== undefined && eventHandling.inline !== false) {
        const caughtUp = await runCatchUp();
        if (caughtUp.isErr()) options.onEventHandlingError?.(caughtUp.error);
      }
      return Result.ok({ status: "ok", value: output.data });
    }
    const error = result.error;
    if (isInfrastructureError(error)) return Result.err(error);
    const wire = isTaggedError(error) ? encodeWireError(contract, error as BusinessError) : undefined;
    if (wire === undefined) return defect(contract, "handler returned an error its contract does not declare", error);
    return Result.ok({ status: "error", error: wire });
  };

  return {
    contracts,
    dispatch,
    execute: async (contract, input, metadata) => {
      const { kind, type, version } = contract as AnyOperationContract;
      const dispatched = await dispatch({ kind, type, version, input, ...(metadata === undefined ? {} : { metadata }) });
      if (dispatched.isErr()) return Result.err(dispatched.error);
      const result = dispatched.value;
      if (result.status === "ok") return Result.ok(result.value as OutputOf<typeof contract>);
      const error = decodeWireError(contract, result.error);
      return error === undefined ? defect(contract, `cannot decode error ${result.error.type}`) : Result.err(error);
    },
    catchUp: runCatchUp,
  };
}
