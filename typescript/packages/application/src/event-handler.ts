import { Result, panic, type AnyEventDefinition, type DomainEvent, type z } from "@projected/domain";
import type { InfrastructureError } from "./errors.js";
import type { CheckpointStore, EventStore, ExecutionContext, RecordedEvent } from "./ports.js";

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

type MaybePromise<T> = T | Promise<T>;
type DefinitionFor<Events extends readonly AnyEventDefinition[], Type> = Extract<Events[number], { readonly type: Type }>;

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
}

export interface DefineEventHandlerOptions<Events extends readonly AnyEventDefinition[]> {
  readonly name: string;
  readonly events: Events;
  readonly handle: EventHandlerFunctions<Events>;
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

  return {
    name: options.name,
    eventTypes: [...definitions.keys()],
    handles: (type) => definitions.has(type),
    handle: async (recorded) => {
      const definition = definitions.get(recorded.type);
      const fn = functions[recorded.type];
      if (definition === undefined || fn === undefined) return Result.ok(undefined);
      const event = definition.decode(recorded).match({
        ok: (decoded) => decoded,
        err: (error) => panic(`${options.name}: ${recorded.stream}@${recorded.streamVersion}: ${error.message}`, error),
      });
      const correlationId = typeof recorded.metadata.correlationId === "string" ? recorded.metadata.correlationId : undefined;
      const context: ExecutionContext = {
        metadata: {
          messageId: recorded.eventId,
          correlationId: correlationId ?? recorded.eventId,
          causationId: recorded.eventId,
          idempotencyKey: recorded.eventId,
        },
      };
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
}

/**
 * Feed a handler every event recorded since its checkpoint, in global order, saving progress
 * after each batch. Stops at the first failure, keeping the checkpoint at the last success.
 */
export async function catchUp(
  handler: EventHandler,
  store: EventStore,
  checkpoints: CheckpointStore,
  options: CatchUpOptions = {},
): Promise<Result<CatchUpReport, InfrastructureError>> {
  const batchSize = options.batchSize ?? 100;
  return Result.gen(async function* () {
    const start = yield* Result.await(checkpoints.load(handler.name));
    let position = start;
    let handled = 0;
    for (;;) {
      const batch = yield* Result.await(store.readAll({ after: position, limit: batchSize }));
      for (const recorded of batch) {
        if (handler.handles(recorded.type)) {
          const outcome = await handler.handle(recorded);
          if (outcome.isErr()) {
            if (position !== start) yield* Result.await(checkpoints.save(handler.name, position));
            return Result.err(outcome.error);
          }
          handled++;
        }
        position = recorded.globalPosition;
      }
      if (batch.length > 0) yield* Result.await(checkpoints.save(handler.name, position));
      if (batch.length < batchSize) return Result.ok({ handler: handler.name, handled, position });
    }
  });
}
