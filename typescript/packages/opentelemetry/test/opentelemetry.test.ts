import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Result,
  aggregateRepository,
  createApplication,
  defineAggregate,
  defineCommand,
  defineContracts,
  defineEvent,
  z,
  type CommandHandler,
} from "@projected/application/event-sourced";
import { httpHandler } from "@projected/http";
import { commandQueue, consumeCommands, eventRelay, inMemoryTransport } from "@projected/messaging";
import { openTelemetry } from "@projected/opentelemetry";
import { inMemoryCheckpointStore, inMemoryEventStore } from "@projected/store-memory/event-sourced";
import { sequentialIds } from "@projected/testing/event-sourced";

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));
});
afterAll(() => {
  trace.disable();
  propagation.disable();
  context.disable();
});
beforeEach(() => exporter.reset());

const span = (name: string): ReadableSpan => {
  const found = exporter.getFinishedSpans().find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no span ${name}; have ${exporter.getFinishedSpans().map((s) => s.name).join(", ")}`);
  return found;
};
const parentOf = (child: ReadableSpan) => child.parentSpanContext?.spanId;

const OrderPlaced = defineEvent("OrderPlaced", { schema: z.object({ orderId: z.string() }) });
const Order = defineAggregate({
  name: "order",
  initialState: (): boolean => false,
  events: [OrderPlaced],
  evolve: { OrderPlaced: () => true },
});
const PlaceOrder = defineCommand({ type: "place-order", input: z.object({ orderId: z.string() }), output: z.object({}) });
const ReserveStock = defineCommand({ type: "reserve-stock", input: z.object({ orderId: z.string() }), output: z.object({}) });

describe("openTelemetry", () => {
  it("records spans with kinds, attributes and failures", async () => {
    const telemetry = openTelemetry();

    await telemetry.span("work", { kind: "client", attributes: { "a.b": 1, skipped: undefined } }, async (s) => {
      s.setAttributes({ "c.d": "x" });
      s.fail("nope");
    });

    expect(span("work")).toMatchObject({ kind: 2, attributes: { "a.b": 1, "c.d": "x" }, status: { code: 2, message: "nope" } });
  });

  it("records exceptions thrown inside a span and rethrows them", async () => {
    await expect(openTelemetry().span("boom", {}, async () => Promise.reject(new Error("bang")))).rejects.toThrow("bang");

    expect(span("boom").events.map((event) => event.name)).toEqual(["exception"]);
  });

  it("follows one request through HTTP, the aggregate, the outbox, the broker and another service", async () => {
    const telemetry = openTelemetry();
    const transport = inMemoryTransport();
    const store = inMemoryEventStore();
    const orders = aggregateRepository(Order, store, { telemetry });

    const placeOrder: CommandHandler<typeof PlaceOrder> = async ({ orderId }, ctx) =>
      (await orders.execute(orderId, () => Result.ok([OrderPlaced({ orderId })]), ctx)).map(() => ({}));
    const shop = createApplication(defineContracts({ name: "shop", access: "public", commands: [PlaceOrder] }), {
      ids: sequentialIds("shop"),
      telemetry,
      commands: { "place-order@1": placeOrder },
      eventHandling: {
        handlers: [eventRelay(transport, { name: "shop-events", topic: "shop.events" })],
        store,
        checkpoints: inMemoryCheckpointStore(),
      },
    });

    const warehouseContracts = defineContracts({ name: "warehouse", access: "public", commands: [ReserveStock] });
    const warehouse = createApplication(warehouseContracts, {
      ids: sequentialIds("wh"),
      telemetry,
      commands: { "reserve-stock@1": () => Result.ok({}) },
    });
    await consumeCommands(warehouse, transport, { topic: "warehouse.commands" });
    // The shop's policy: every relayed OrderPlaced asks the warehouse to reserve stock.
    const reserve = commandQueue(warehouseContracts, transport, { topic: "warehouse.commands", ids: sequentialIds("q"), telemetry });
    await transport.subscribe("shop.events", async (message) => {
      const event = message.body as { data: { orderId: string } };
      return telemetry.continueFrom(message.headers, async () =>
        (await reserve.enqueue(ReserveStock, { orderId: event.data.orderId })).isOk() ? "ack" : "retry",
      );
    });

    const caller = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    await httpHandler(shop)(
      new Request("http://shop.test/commands/place-order/version/1", {
        method: "POST",
        headers: { "content-type": "application/json", traceparent: caller },
        body: JSON.stringify({ orderId: "o-1" }),
      }),
    );
    await transport.drain();

    const server = span("POST /commands/{type}/version/{version}");
    const dispatch = span("command place-order@1");
    const execute = span("execute order");
    const relay = span("shop-events OrderPlaced");
    const send = span("send warehouse/reserve-stock@1");
    const receive = span("receive warehouse.commands");
    const reserveSpan = span("command reserve-stock@1");

    const traceIds = new Set([server, dispatch, execute, relay, send, receive, reserveSpan].map((s) => s.spanContext().traceId));
    expect([...traceIds]).toEqual(["4bf92f3577b34da6a3ce929d0e0e4736"]);
    expect(parentOf(server)).toBe("00f067aa0ba902b7");
    expect(parentOf(dispatch)).toBe(server.spanContext().spanId);
    expect(parentOf(execute)).toBe(dispatch.spanContext().spanId);
    expect(parentOf(relay)).toBe(dispatch.spanContext().spanId);
    expect(parentOf(receive)).toBe(send.spanContext().spanId);
    expect(parentOf(reserveSpan)).toBe(receive.spanContext().spanId);
    expect(server.attributes["http.response.status_code"]).toBe(200);
  });
});
