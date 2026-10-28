/**
 * @projected/application — what your application layer (`src/application/**`) imports.
 *
 * This entry point holds what both flavours share: contracts, the dispatcher, ports, event
 * handlers and remote services. Aggregate repositories and the aggregate store port come from the
 * project's flavour, which also re-exports all of this and the flavour's domain kernel:
 * `@projected/application/event-sourced` or `@projected/application/state-based`. Like the domain
 * kernel, it is free of I/O: ports are interfaces, adapters live in infrastructure packages.
 */
export * from "@projected/domain";

export {
  defineCommand,
  defineContracts,
  defineQuery,
  type Access,
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
  Forbidden,
  IdempotencyKeyReused,
  InvalidInput,
  OperationDefect,
  RequestInProgress,
  Unauthenticated,
  UnknownOperation,
  UnknownTask,
  isDispatchError,
  isInfrastructureError,
  type AccessError,
  type DispatchError,
  type IdempotencyError,
  type InfrastructureError,
  type OperateError,
  type ValidationIssue,
} from "./errors.js";
export { OPERATE, defineOperatorTask, type OperatorTask } from "./operator.js";
export type {
  Authenticator,
  CheckpointStore,
  Clock,
  DocumentCollection,
  DocumentFilter,
  DocumentStore,
  EventLog,
  EventMetadata,
  ExecutionContext,
  ExpectedVersion,
  FindOptions,
  IdGenerator,
  IdempotencyClaim,
  IdempotencyStore,
  Metadata,
  NewEvent,
  Principal,
  ReadinessCheck,
  SchemaMigrator,
  RecordedEvent,
} from "./ports.js";
export {
  currentTrace,
  noTelemetry,
  traceCarrier,
  type AttributeValue,
  type Attributes,
  type Span,
  type SpanKind,
  type SpanOptions,
  type Telemetry,
} from "./telemetry.js";
export { canonicalJson, sha256 } from "./fingerprint.js";
export { eventMetadataFrom } from "./event-metadata.js";
export { classifyFailure, fromDependency, type FailureKind, type FromDependencyOptions } from "./dependency.js";
export {
  catchUp,
  defineEventHandler,
  handleTraced,
  type CatchUpOptions,
  type CatchUpReport,
  type DefineEventHandlerOptions,
  type EventHandler,
  type EventHandlerFunctions,
  type HandledEvent,
} from "./event-handler.js";
export {
  checkAccess,
  createApplication,
  type Application,
  type ApplicationOptions,
  type CommandHandler,
  type EventHandlerBacklog,
  type EventHandlingOptions,
  type Handler,
  type HandlerMap,
  type HealthReport,
  type IdempotencyOptions,
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
