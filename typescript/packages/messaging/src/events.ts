import {
  Result,
  handleTraced,
  noTelemetry,
  traceCarrier,
  type AnyEventDefinition,
  type EventHandler,
  type RecordedEvent,
  type Telemetry,
} from "@projected/application";
import { z } from "zod";
import type { Disposition, MessageTransport, Subscription } from "./transport.js";

/** A recorded event travelling through a broker. Exactly the {@link RecordedEvent} shape. */
export const EventMessage = z.object({
  eventId: z.string(),
  stream: z.string(),
  streamVersion: z.number().int().positive(),
  globalPosition: z.number().int().positive(),
  type: z.string(),
  schemaVersion: z.number().int().positive(),
  data: z.unknown(),
  metadata: z.record(z.string(), z.unknown()),
  recordedAt: z.string(),
});

export interface EventRelayOptions {
  /** Kebab-case; also the relay's checkpoint name. */
  readonly name: string;
  readonly topic: string;
  /** Only relay these events. Defaults to every event in the store. */
  readonly events?: readonly AnyEventDefinition[];
}

/** The trace context an event was recorded under, if any. */
const eventTrace = (recorded: RecordedEvent) => {
  const trace = recorded.metadata.trace;
  return traceCarrier(typeof trace === "object" && trace !== null ? (trace as Record<string, unknown>) : undefined);
};

/**
 * An event handler that publishes recorded events to a topic. Register it with the
 * application's event handling: it reads the store from its checkpoint, so the event store acts
 * as the outbox and nothing is lost between "saved" and "published". At-least-once. Events are
 * keyed by stream, so a partitioned broker keeps each aggregate's events in order, and carry the
 * trace they were recorded under.
 */
export function eventRelay(transport: MessageTransport, options: EventRelayOptions): EventHandler {
  const types = options.events?.map((definition) => definition.type);
  const handles = (type: string) => types === undefined || types.includes(type);
  return {
    name: options.name,
    eventTypes: types ?? [],
    handles,
    handle: async (recorded) =>
      transport.publish(options.topic, {
        id: recorded.eventId,
        key: recorded.stream,
        body: recorded,
        headers: eventTrace(recorded) ?? {},
      }),
  };
}

export interface ConsumeEventsOptions {
  readonly topic: string;
  /** Competing-consumer group. Defaults to the handler's name, so each handler sees every event. */
  readonly group?: string;
  /** Each handled event gets a span, continuing the trace it was recorded under. */
  readonly telemetry?: Telemetry;
  readonly onRejected?: (body: unknown, reason: string) => void;
}

/**
 * Feed events published by another service (through {@link eventRelay}) to one of your event
 * handlers — typically a projection built from that service's event definitions.
 */
export function consumeEvents(
  handler: EventHandler,
  transport: MessageTransport,
  options: ConsumeEventsOptions,
): Promise<Subscription> {
  const telemetry = options.telemetry ?? noTelemetry;
  return transport.subscribe(
    options.topic,
    async (message): Promise<Disposition> => {
      const parsed = EventMessage.safeParse(message.body);
      if (!parsed.success) {
        options.onRejected?.(message.body, "not an event message");
        return "dead-letter";
      }
      const recorded = parsed.data as RecordedEvent;
      if (!handler.handles(recorded.type)) return "ack";
      const outcome = await Result.tryPromise(() => handleTraced(handler, recorded, telemetry));
      if (outcome.isErr()) {
        options.onRejected?.(message.body, "handler could not decode or process the event");
        return "dead-letter";
      }
      return outcome.value.isOk() ? "ack" : "retry";
    },
    { group: options.group ?? handler.name },
  );
}
