import { describe, expect, it } from "vitest";
import {
  Result,
  aggregateRepository,
  createApplication,
  defineAggregate,
  defineCommand,
  defineContracts,
  defineError,
  defineEvent,
  defineEventHandler,
  DependencyUnavailable,
  z,
  type CommandHandler,
} from "@projected/application/event-sourced";
import { inMemoryCheckpointStore, inMemoryEventStore } from "@projected/store-memory/event-sourced";
import { commandQueue, consumeCommands, consumeEvents, eventRelay, inMemoryTransport } from "@projected/messaging";
import { sequentialIds } from "@projected/testing/event-sourced";
import { messageTransportConformance } from "@projected/testing/messaging";

class AlreadyShipped extends defineError("AlreadyShipped", { schema: z.object({ orderId: z.string() }) }) {}
const OrderShipped = defineEvent("OrderShipped", { schema: z.object({ orderId: z.string() }) });
const Order = defineAggregate({
  name: "order",
  initialState: (): { shipped: boolean } => ({ shipped: false }),
  events: [OrderShipped],
  evolve: { OrderShipped: () => ({ shipped: true }) },
});
const ShipOrder = defineCommand({
  type: "ship-order",
  input: z.object({ orderId: z.string().min(1) }),
  output: z.object({}),
  errors: [AlreadyShipped],
});
const contracts = defineContracts({ name: "shipping", access: "public", commands: [ShipOrder] });

function shipping(options: { failFirst?: boolean } = {}) {
  const store = inMemoryEventStore();
  const orders = aggregateRepository(Order, store);
  let failures = options.failFirst ? 1 : 0;
  const shipOrder: CommandHandler<typeof ShipOrder> = async ({ orderId }, context) => {
    if (failures-- > 0) return Result.err(new DependencyUnavailable({ dependency: "warehouse", message: "down" }));
    return (
      await orders.execute(
        orderId,
        (state) => (state.shipped ? Result.err(new AlreadyShipped({ orderId })) : Result.ok([OrderShipped({ orderId })])),
        context,
      )
    ).map(() => ({}));
  };
  const transport = inMemoryTransport();
  const checkpoints = inMemoryCheckpointStore();
  const app = createApplication(contracts, {
    ids: sequentialIds("msg"),
    commands: { "ship-order@1": shipOrder },
    eventHandling: {
      handlers: [eventRelay(transport, { name: "shipping-events", topic: "shipping.events" })],
      store,
      checkpoints,
    },
  });
  return { app, store, transport };
}

describe("queued commands", () => {
  it("run through the application, with their outcome observable", async () => {
    const { app, store, transport } = shipping();
    const outcomes: string[] = [];
    await consumeCommands(app, transport, { topic: "shipping.commands", onOutcome: (_, result) => outcomes.push(result.status) });
    const queue = commandQueue(contracts, transport, { topic: "shipping.commands", ids: sequentialIds("cmd") });

    await queue.enqueue(ShipOrder, { orderId: "o-1" });
    await queue.enqueue(ShipOrder, { orderId: "o-1" });
    await transport.drain();

    expect(outcomes).toEqual(["ok", "error"]);
    expect(store.stream("order-o-1")).toHaveLength(1);
  });

  it("carry correlation from the sending context", async () => {
    const { app, store, transport } = shipping();
    await consumeCommands(app, transport, { topic: "shipping.commands" });
    const queue = commandQueue(contracts, transport, { topic: "shipping.commands", ids: sequentialIds("cmd") });
    const context = { metadata: { messageId: "web-1", correlationId: "flow-1", causationId: undefined, idempotencyKey: undefined } };

    await queue.enqueue(ShipOrder, { orderId: "o-1" }, context);
    await transport.drain();

    expect(store.all[0]?.metadata).toEqual({ correlationId: "flow-1", causationId: "cmd-1" });
  });

  it("are retried after an infrastructure error", async () => {
    const { app, store, transport } = shipping({ failFirst: true });
    await consumeCommands(app, transport, { topic: "shipping.commands" });

    await commandQueue(contracts, transport, { topic: "shipping.commands", ids: sequentialIds() }).enqueue(ShipOrder, {
      orderId: "o-1",
    });
    await transport.drain();

    expect(store.all).toHaveLength(1);
    expect(transport.deadLetters).toHaveLength(0);
  });

  it("are dead-lettered when they can never succeed", async () => {
    const { app, transport } = shipping();
    await consumeCommands(app, transport, { topic: "shipping.commands" });

    await transport.publish("shipping.commands", { id: "x", body: { kind: "command", type: "ship-order", version: 9, data: {}, metadata: { messageId: "x", correlationId: "x" } } });
    await transport.publish("shipping.commands", { id: "y", body: "garbage" });
    await transport.drain();

    expect(transport.deadLetters.map((m) => m.id)).toEqual(["x", "y"]);
  });

  it("are validated before they are sent", async () => {
    const transport = inMemoryTransport();

    const outcome = await commandQueue(contracts, transport, { topic: "t", ids: sequentialIds() }).enqueue(ShipOrder, { orderId: "" });

    expect(outcome.isErr() && outcome.error._tag).toBe("DependencyFailure");
    expect(transport.published).toHaveLength(0);
  });
});

describe("event relay", () => {
  it("publishes recorded events, which another service can consume", async () => {
    const { app, transport } = shipping();
    const notified: string[] = [];
    const notifications = defineEventHandler({
      name: "shipping-notifications",
      events: [OrderShipped],
      handle: {
        OrderShipped: ({ data }) => {
          notified.push(data.orderId);
          return Result.ok(undefined);
        },
      },
    });
    await consumeEvents(notifications, transport, { topic: "shipping.events" });

    await app.execute(ShipOrder, { orderId: "o-1" });
    await transport.drain();

    expect(transport.published.map((m) => (m.body as { type: string }).type)).toEqual(["OrderShipped"]);
    expect(notified).toEqual(["o-1"]);
  });
});

messageTransportConformance("in-memory", {
  create: () => {
    const transport = inMemoryTransport({ maxAttempts: 3 });
    return { transport, drain: () => transport.drain() };
  },
  maxAttempts: 3,
  durable: true,
});
