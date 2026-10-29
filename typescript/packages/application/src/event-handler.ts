import { Result, panic, type AnyEventDefinition, type DomainEvent, type z } from "@projected/domain";
import { OperationDefect, defectReason, type InfrastructureError } from "./errors.js";
import type { CheckpointStore, EventLog, ExecutionContext, RecordedEvent } from "./ports.js";
import { noTelemetry, traceCarrier, type Telemetry } from "./telemetry.js";
import { KEBAB_CASE, type MaybePromise } from "./naming.js";

type DefinitionFor<Events extends readonly AnyEventDefinition[], Type> = Extract<Events[number], { readonly type: Type }>;

/**
 * Why an event handler stopped: an infrastructure error, which a later catch-up may get past, or
 * a defect — the handler threw, or the event no longer decodes — which needs a fix.
 */
export type EventHandlingError = InfrastructureError | OperationDefect;

/** A decoded event together with where and when it was recorded. */
export interface HandledEvent<Type extends string = string, Data = unknown> extends DomainEvent<Type, Data> {
  readonly eventId: string;
  readonly stream: string;
  readonly streamVersion: number;
  readonly globalPosition: number;
  readonly recordedAt: string;
}

/** One function per subscribed event type. Exhaustive over `events`, checked at compile time. */
export type EventHandlerFunctions<Events extends readonly AnyEventDefinition[]> = {
  readonly [Type in Events[number]["type"]]: (
    event: HandledEvent<Type, z.output<DefinitionFor<Events, Type>["schema"]>>,
    context: ExecutionContext,
  ) => MaybePromise<Result<void, InfrastructureError>>;
};

/**
 * Reacts to events from the global log: a projection (updates a read model through a driven
 * port) or a policy (calls other ports or services). Delivery is at-least-once — make handlers
 * idempotent.
 */
export interface EventHandler {
  /** Kebab-case. Also the checkpoint key, so renaming it replays every event. */
  readonly name: string;
  readonly eventTypes: readonly string[];
  handles(type: string): boolean;
  handle(recorded: RecordedEvent): Promise<Result<void, InfrastructureError>>;
  /** Forget everything it has built, before a rebuild replays every event to it. */
  reset?(): Promise<Result<void, InfrastructureError>>;
  /** How many streams it works on at once; 1 when absent. Each stream's events stay in order. */
  readonly concurrency?: number;
}

export interface DefineEventHandlerOptions<Events extends readonly AnyEventDefinition[]> {
  readonly name: string;
  readonly events: Events;
  readonly handle: EventHandlerFunctions<Events>;
  /**
   * Clear what the handler has built — a read model's documents — before the `rebuild` operator
   * task replays every event to it. Without it, a rebuild replays over what is there, which is
   * enough for a handler whose every effect is an idempotent upsert or delete.
   */
  readonly reset?: () => MaybePromise<Result<void, InfrastructureError>>;
  /**
   * How many streams the handler works on at once. Defaults to 1: one event at a time, in the
   * log's order. Above 1, each stream's events still arrive in order, one at a time, but those of
   * different streams overlap — for a handler whose work on one stream never waits on another
   * stream's events, such as a process that keeps each instance in a stream of its own.
   */
  readonly concurrency?: number;
}

/**
 * Define an event handler.
 *
 * ```ts
 * export const studentDirectoryProjection = (deps: { directory: StudentDirectory }) =>
 *   defineEventHandler({
 *     name: "student-directory",
 *     events: [StudentEnlisted, StudentLeft],
 *     handle: {
 *       StudentEnlisted: ({ data }) => deps.directory.add(data),
 *       StudentLeft: ({ data }) => deps.directory.remove(data.studentId),
 *     },
 *   });
 * ```
 */
export function defineEventHandler<const Events extends readonly AnyEventDefinition[]>(
  options: DefineEventHandlerOptions<Events>,
): EventHandler {
  if (!KEBAB_CASE.test(options.name)) {
    panic(`defineEventHandler: name "${options.name}" must be kebab-case`);
  }
  const definitions = new Map<string, AnyEventDefinition>(options.events.map((d) => [d.type, d]));
  const functions = options.handle as unknown as Record<
    string,
    (event: HandledEvent, context: ExecutionContext) => MaybePromise<Result<void, InfrastructureError>>
  >;
  for (const type of definitions.keys()) {
    if (typeof functions[type] !== "function") panic(`defineEventHandler("${options.name}"): no handler for ${type}`);
  }

  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) panic(`defineEventHandler("${options.name}"): concurrency must be a positive integer, got ${concurrency}`);

  const reset = options.reset;
  return {
    name: options.name,
    eventTypes: [...definitions.keys()],
    concurrency,
    handles: (type) => definitions.has(type),
    ...(reset === undefined ? {} : { reset: async () => reset() }),
    handle: async (recorded) => {
      const definition = definitions.get(recorded.type);
      const fn = functions[recorded.type];
      if (definition === undefined || fn === undefined) return Result.ok(undefined);
      const event = definition.decode(recorded).match({
        ok: (decoded) => decoded,
        err: (error) => panic(`${options.name}: ${recorded.stream}@${recorded.streamVersion}: ${error.message}`, error),
      });
      const context: ExecutionContext = { metadata: eventContext(recorded) };
      return fn(
        {
          ...event,
          eventId: recorded.eventId,
          stream: recorded.stream,
          streamVersion: recorded.streamVersion,
          globalPosition: recorded.globalPosition,
          recordedAt: recorded.recordedAt,
        },
        context,
      );
    },
  };
}

export interface CatchUpReport {
  readonly handler: string;
  /** Events this handler acted on in this run. */
  readonly handled: number;
  /** Global position the handler has now processed up to. */
  readonly position: number;
}

export interface CatchUpOptions {
  readonly batchSize?: number;
  /** Each handled event gets a span, continuing the trace that produced the event. */
  readonly telemetry?: Telemetry;
}

/**
 * The context a reaction to `recorded` runs in: correlated with the flow that produced it,
 * caused by it, and keyed by its id so that anything it sends is idempotent across redeliveries.
 */
function eventContext(recorded: RecordedEvent): ExecutionContext["metadata"] {
  const { correlationId, trace } = recorded.metadata;
  const carrier = traceCarrier(typeof trace === "object" && trace !== null ? (trace as Record<string, unknown>) : undefined);
  return {
    messageId: recorded.eventId,
    correlationId: typeof correlationId === "string" ? correlationId : recorded.eventId,
    causationId: recorded.eventId,
    idempotencyKey: recorded.eventId,
    ...(carrier === undefined ? {} : { trace: carrier }),
  };
}

/**
 * Run one handler on one event inside a span that continues the event's trace. A handler that
 * throws — or meets an event it cannot decode — gives an {@link OperationDefect}, never a
 * rejection: one bad handler must not take the process down.
 */
export function handleTraced(
  handler: EventHandler,
  recorded: RecordedEvent,
  telemetry: Telemetry,
): Promise<Result<void, EventHandlingError>> {
  return telemetry.continueFrom(eventContext(recorded).trace, () =>
    telemetry.span(
      `${handler.name} ${recorded.type}`,
      {
        kind: "consumer",
        attributes: {
          "projected.event_handler": handler.name,
          "projected.event.type": recorded.type,
          "projected.event.id": recorded.eventId,
          "projected.stream": recorded.stream,
          "projected.global_position": recorded.globalPosition,
        },
      },
      async (span): Promise<Result<void, EventHandlingError>> => {
        let outcome: Result<void, EventHandlingError>;
        try {
          outcome = await handler.handle(recorded);
        } catch (cause) {
          const reason = defectReason(cause);
          outcome = Result.err(
            new OperationDefect({
              operation: `event-handler ${handler.name}`,
              message: `${handler.name} threw on ${recorded.type} ${recorded.stream}@${recorded.streamVersion}${reason === undefined ? "" : `: ${reason}`}`,
              cause,
            }),
          );
        }
        if (outcome.isErr()) span.fail(outcome.error.message);
        return outcome;
      },
    ),
  );
}

/** What handling one batch came to: how many events were handled, and the first in log order that failed. */
interface BatchOutcome {
  readonly handled: number;
  readonly failed?: { readonly index: number; readonly error: EventHandlingError };
}

/** The batch's events in log order, one at a time, stopping at the first failure. */
async function inOrder(handler: EventHandler, batch: readonly RecordedEvent[], telemetry: Telemetry): Promise<BatchOutcome> {
  let handled = 0;
  for (const [index, recorded] of batch.entries()) {
    if (!handler.handles(recorded.type)) continue;
    const outcome = await handleTraced(handler, recorded, telemetry);
    if (outcome.isErr()) return { handled, failed: { index, error: outcome.error } };
    handled++;
  }
  return { handled };
}

/**
 * The batch's events stream by stream, `concurrency` streams at a time: each stream's in order,
 * stopping at its first failure. The failure reported is the earliest in log order, so that the
 * checkpoint never passes an event that was not handled.
 */
async function byStream(handler: EventHandler, batch: readonly RecordedEvent[], telemetry: Telemetry, concurrency: number): Promise<BatchOutcome> {
  const streams = new Map<string, number[]>();
  for (const [index, recorded] of batch.entries()) {
    if (handler.handles(recorded.type)) streams.set(recorded.stream, [...(streams.get(recorded.stream) ?? []), index]);
  }
  const queue = [...streams.values()];
  let handled = 0;
  let failed: BatchOutcome["failed"];
  const work = async () => {
    for (let indices = queue.shift(); indices !== undefined; indices = queue.shift()) {
      for (const index of indices) {
        const recorded = batch[index];
        if (recorded === undefined) break;
        const outcome = await handleTraced(handler, recorded, telemetry);
        if (outcome.isErr()) {
          if (failed === undefined || index < failed.index) failed = { index, error: outcome.error };
          break;
        }
        handled++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, work));
  return failed === undefined ? { handled } : { handled, failed };
}

/**
 * Feed a handler every event recorded since its checkpoint, in global order — or stream by
 * stream, for a handler with `concurrency` — saving progress after each batch. Stops at the
 * first failure, keeping the checkpoint just before it, so the failing event is the first one
 * the next catch-up offers. With `concurrency`, later events of other streams may have been
 * handled already, and are offered again: handlers are idempotent.
 */
export async function catchUp(
  handler: EventHandler,
  store: EventLog,
  checkpoints: CheckpointStore,
  options: CatchUpOptions = {},
): Promise<Result<CatchUpReport, EventHandlingError>> {
  const batchSize = options.batchSize ?? 100;
  const telemetry = options.telemetry ?? noTelemetry;
  const concurrency = handler.concurrency ?? 1;
  return Result.gen(async function* () {
    const start = yield* Result.await(checkpoints.load(handler.name));
    let position = start;
    let handled = 0;
    for (;;) {
      const batch = yield* Result.await(store.readAll({ after: position, limit: batchSize }));
      const outcome = concurrency === 1 ? await inOrder(handler, batch, telemetry) : await byStream(handler, batch, telemetry, concurrency);
      handled += outcome.handled;
      if (outcome.failed !== undefined) {
        position = batch[outcome.failed.index - 1]?.globalPosition ?? position;
        if (position !== start) yield* Result.await(checkpoints.save(handler.name, position));
        return Result.err(outcome.failed.error);
      }
      position = batch.at(-1)?.globalPosition ?? position;
      if (batch.length > 0) yield* Result.await(checkpoints.save(handler.name, position));
      if (batch.length < batchSize) return Result.ok({ handler: handler.name, handled, position });
    }
  });
}
