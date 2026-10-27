import type { Result } from "@projected/domain";
import type { Application } from "./application.js";
import type { AnyContracts, CommandsOf, ErrorOf, OperationsOf, OutputOf, RequestOf } from "./contract.js";
import {
  ConcurrencyConflict,
  DependencyFailure,
  DependencyUnavailable,
  isDispatchError,
  isInfrastructureError,
  type DispatchError,
  type InfrastructureError,
} from "./errors.js";
import type { ExecutionContext, Metadata } from "./ports.js";

/**
 * Driven port for calling another service's commands and queries and waiting for the outcome.
 *
 * The result has exactly the shape of the remote handler's own signature — its output, its
 * declared business errors, or an infrastructure error — so a use case can `yield*` it and let
 * errors propagate without translation. Whether the call goes over HTTP or stays in-process is
 * decided in the composition root.
 */
export interface RemoteService<C extends AnyContracts> {
  readonly contracts: C;
  execute<Op extends OperationsOf<C>>(
    contract: Op,
    input: RequestOf<Op>,
    context?: ExecutionContext,
  ): Promise<Result<OutputOf<Op>, ErrorOf<Op> | InfrastructureError>>;
}

/** A command accepted for asynchronous processing. */
export interface Enqueued {
  readonly messageId: string;
}

/**
 * Driven port for sending commands to be processed asynchronously (fire-and-forget). The
 * receiving side runs them through the same contracts and handlers as HTTP requests.
 * `DependencyFailure` means the command was refused before sending (its input is invalid).
 */
export interface CommandQueue<C extends AnyContracts> {
  readonly contracts: C;
  enqueue<Op extends CommandsOf<C>>(
    contract: Op,
    input: RequestOf<Op>,
    context?: ExecutionContext,
  ): Promise<Result<Enqueued, DependencyUnavailable | DependencyFailure>>;
}

/** Metadata for a message sent while handling `context`: same correlation, caused by it. */
export function propagate(context: ExecutionContext | undefined): Partial<Metadata> {
  if (context === undefined) return {};
  return { correlationId: context.metadata.correlationId, causationId: context.metadata.messageId };
}

/**
 * How a caller sees a dispatch error from another service: its protocol-level rejections are
 * our contract mismatch (a failure), its infrastructure errors are ours too.
 */
export function asCallerError(dependency: string, error: DispatchError): InfrastructureError {
  if (ConcurrencyConflict.is(error)) {
    return new DependencyUnavailable({ dependency, message: `${dependency}: ${error.message}`, cause: error });
  }
  if (isInfrastructureError(error)) return error;
  return new DependencyFailure({ dependency, message: `${dependency} rejected the request: ${error.message}`, cause: error });
}

/**
 * A {@link RemoteService} that calls an {@link Application} in the same process, through the
 * same validation and serialization as a network call. Use it for modular monoliths and tests.
 */
export function inProcessService<C extends AnyContracts>(app: Application<C>): RemoteService<C> {
  return {
    contracts: app.contracts,
    execute: async (contract, input, context) => {
      const outcome = await app.execute(contract, input, propagate(context));
      return outcome.mapError((error) =>
        isDispatchError(error) ? asCallerError(app.contracts.name, error) : error,
      ) as Result<OutputOf<typeof contract>, ErrorOf<typeof contract> | InfrastructureError>;
    },
  };
}
