/**
 * @projected/application — what your application layer (`src/application/**`) imports.
 *
 * Re-exports the whole domain kernel, so use cases and contracts need a single import. Like the
 * domain kernel, it is free of I/O: ports are interfaces, adapters live in infrastructure packages.
 */
export * from "@projected/domain";

export {
  defineCommand,
  defineContracts,
  defineQuery,
  type AnyCommandContract,
  type AnyContracts,
  type AnyOperationContract,
  type AnyQueryContract,
  type CommandContract,
  type CommandsOf,
  type Contracts,
  type DefineContractsOptions,
  type DefineOperationOptions,
  type ErrorOf,
  type InputOf,
  type OperationContract,
  type OperationKind,
  type OperationsOf,
  type OutputOf,
  type QueriesOf,
  type QueryContract,
  type RequestOf,
} from "./contract.js";
export {
  ConcurrencyConflict,
  DependencyFailure,
  DependencyUnavailable,
  InvalidInput,
  OperationDefect,
  UnknownOperation,
  isDispatchError,
  isInfrastructureError,
  type DispatchError,
  type InfrastructureError,
  type ValidationIssue,
} from "./errors.js";
export type {
  AppendResult,
  CheckpointStore,
  Clock,
  EventMetadata,
  EventStore,
  ExecutionContext,
  ExpectedVersion,
  IdGenerator,
  Metadata,
  NewEvent,
  RecordedEvent,
  StreamSlice,
} from "./ports.js";
export {
  aggregateRepository,
  type AggregateRepository,
  type AggregateRepositoryOptions,
  type ExecutedDecision,
  type LoadedAggregate,
} from "./repository.js";
export {
  catchUp,
  defineEventHandler,
  type CatchUpOptions,
  type CatchUpReport,
  type DefineEventHandlerOptions,
  type EventHandler,
  type EventHandlerFunctions,
  type HandledEvent,
} from "./event-handler.js";
export {
  createApplication,
  type Application,
  type ApplicationOptions,
  type CommandHandler,
  type EventHandlingOptions,
  type Handler,
  type HandlerMap,
  type QueryHandler,
} from "./application.js";
export {
  asCallerError,
  inProcessService,
  propagate,
  type CommandQueue,
  type Enqueued,
  type RemoteService,
} from "./remote.js";
export {
  decodeWireError,
  encodeWireError,
  toValidationIssues,
  type OperationRequest,
  type OperationResult,
  type WireError,
} from "./wire.js";
