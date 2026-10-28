import { describe, expect, it } from "vitest";
import { Result, createApplication, defineContracts, defineEvent, defineEventHandler, z } from "@projected/application/event-sourced";
import { inMemoryCheckpointStore, inMemoryEventStore } from "@projected/store-memory/event-sourced";
import { DEAD_LETTER_REASON_HEADER, consumeEvents, eventRelay, inMemoryTransport, type Disposition, type Message } from "@projected/messaging";
import { sequentialIds } from "@projected/testing/event-sourced";

const collect = (received: Message[], disposition: Disposition = "ack") => async (message: Message): Promise<Disposition> => {
  received.push(message);
  return disposition;
};

/** A handler that waits for `release()` before acknowledging. */
function gated() {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => (release = resolve));
  const received: Message[] = [];
  const handler = async (message: Message): Promise<Disposition> => {
    received.push(message);
    await opened;
    return "ack";
  };
  return { handler, received, release: () => release() };
}

describe("the in-memory transport", () => {
  it("never delivers inside publish, and acknowledged publish returns once every group has handled the message", async () => {
    const transport = inMemoryTransport();
    const billing: Message[] = [];
    const shipping: Message[] = [];
    await transport.subscribe("orders", collect(billing), { group: "billing" });
    await transport.subscribe("orders", collect(shipping), { group: "shipping" });

    const sent = transport.publish("orders", { id: "o-1", body: {} });
    const duringPublish = billing.length + shipping.length;
    const outcome = await sent;

    expect(duringPublish).toBe(0);
    expect(outcome.isOk()).toBe(true);
    expect([billing.length, shipping.length]).toEqual([1, 1]);
  });

  it("returns from an async publish before delivering", async () => {
    const transport = inMemoryTransport({ delivery: "async" });
    const received: Message[] = [];
    await transport.subscribe("orders", collect(received));

    (await transport.publish("orders", { id: "o-1", body: {} })).unwrap();
    const afterPublish = received.length;
    await transport.drain();

    expect(afterPublish).toBe(0);
    expect(received).toHaveLength(1);
  });

  it("fails an acknowledged publish no consumer handles in time, and still delivers the message", async () => {
    const transport = inMemoryTransport({ ackTimeoutMs: 50 });
    const slow = gated();
    await transport.subscribe("orders", slow.handler);

    const outcome = await transport.publish("orders", { id: "o-1", body: {} });
    slow.release();
    await transport.drain();

    expect(outcome.isErr() && outcome.error.message).toMatch(/no acknowledgement for o-1 on orders within 50 ms/);
    expect(slow.received).toHaveLength(1);
  });

  it("reports at once a group with no subscriber, and keeps the message for it", async () => {
    const transport = inMemoryTransport();
    await (await transport.subscribe("orders", collect([]), { group: "billing" })).close();
    const received: Message[] = [];

    const outcome = await transport.publish("orders", { id: "o-1", body: {} });
    await transport.subscribe("orders", collect(received), { group: "billing" });
    await transport.drain();

    expect(outcome.isErr() && outcome.error.message).toMatch(/no subscriber in group billing for orders; kept for it/);
    expect(received.map((message) => message.id)).toEqual(["o-1"]);
  });

  it("tells a waiting publisher as soon as its group's last subscriber leaves", async () => {
    const transport = inMemoryTransport();
    const slow = gated();
    const subscription = await transport.subscribe("orders", slow.handler);
    const first = transport.publish("orders", { id: "o-1", body: {} });
    const second = transport.publish("orders", { id: "o-2", body: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const closed = subscription.close();
    slow.release();
    await closed;

    expect((await first).isOk()).toBe(true);
    expect((await second).isErr()).toBe(true);
    expect(slow.received.map((message) => message.id)).toEqual(["o-1"]);
  });

  it("leaves the other subscribers of a group alone when one subscription is closed twice", async () => {
    const transport = inMemoryTransport();
    const first: Message[] = [];
    const second: Message[] = [];
    const subscription = await transport.subscribe("orders", collect(first));
    await transport.subscribe("orders", collect(second));

    await subscription.close();
    await subscription.close();
    await transport.publish("orders", { id: "o-1", body: {} });

    expect([first.length, second.length]).toEqual([0, 1]);
  });

  it("keeps a relay's checkpoint until its consumers have handled the event, so a restart publishes it again", async () => {
    const Shipped = defineEvent("OrderShipped", { schema: z.object({ orderId: z.string() }) });
    const store = inMemoryEventStore();
    const checkpoints = inMemoryCheckpointStore();
    await store.appendToStream("order-1", [Shipped.encode(Shipped({ orderId: "1" }))], { expectedVersion: 0 });
    const service = (transport: ReturnType<typeof inMemoryTransport>) =>
      createApplication(defineContracts({ name: "shipping", access: "public" }), {
        ids: sequentialIds(),
        eventHandling: { handlers: [eventRelay(transport, { name: "shipping-events", topic: "shipping.events" })], store, checkpoints, inline: false },
      });
    const notified: string[] = [];
    const notifications = defineEventHandler({
      name: "notifications",
      events: [Shipped],
      handle: {
        OrderShipped: ({ data }) => {
          notified.push(data.orderId);
          return Result.ok(undefined);
        },
      },
    });
    // The process dies while its consumer is still busy with the event.
    const before = inMemoryTransport({ ackTimeoutMs: 50 });
    await before.subscribe("shipping.events", gated().handler, { group: "notifications" });
    const stalled = await service(before).catchUp();
    const kept = (await checkpoints.load("shipping-events")).unwrap();

    // After the restart, the relay starts again from its checkpoint.
    const after = inMemoryTransport();
    await consumeEvents(notifications, after, { topic: "shipping.events" });
    const resumed = await service(after).catchUp();

    expect(stalled.isErr()).toBe(true);
    expect(kept).toBe(0);
    expect(resumed.isOk()).toBe(true);
    expect(notified).toEqual(["1"]);
    expect((await checkpoints.load("shipping-events")).unwrap()).toBe(1);
  });

  it("delivers what is waiting on close, then refuses to publish and reports itself down", async () => {
    const transport = inMemoryTransport({ delivery: "async" });
    const received: Message[] = [];
    await transport.subscribe("orders", collect(received));
    await transport.publish("orders", { id: "o-1", body: {} });
    await transport.publish("orders", { id: "o-2", body: {} });

    await transport.close();
    const late = await transport.publish("orders", { id: "o-3", body: {} });
    const pinged = await transport.ping();

    expect(received.map((message) => message.id)).toEqual(["o-1", "o-2"]);
    expect(late.isErr() && late.error.message).toMatch(/closed/);
    expect(pinged.isErr()).toBe(true);
  });

  it("copies bodies and headers as JSON, as a broker would", async () => {
    const transport = inMemoryTransport();
    const received: Message[] = [];
    await transport.subscribe("orders", collect(received));
    const body = { at: new Date("2024-03-01T10:00:00.000Z"), items: ["a"] };

    await transport.publish("orders", { id: "o-1", body, headers: { traceparent: "t" } });
    body.items.push("b");

    expect(received[0]?.body).toEqual({ at: "2024-03-01T10:00:00.000Z", items: ["a"] });
    expect(received[0]?.headers.traceparent).toBe("t");
  });

  it("retries a consumer that throws, and reports what it threw", async () => {
    const errors: unknown[] = [];
    const transport = inMemoryTransport({ retryDelayMs: () => 1, onError: (error) => errors.push(error) });
    const attempts: number[] = [];
    await transport.subscribe("orders", async (message) => {
      attempts.push(message.attempt);
      if (message.attempt === 1) throw new Error("consumer bug");
      return "ack";
    });

    const outcome = await transport.publish("orders", { id: "o-1", body: {} });

    expect(outcome.isOk()).toBe(true);
    expect(attempts).toEqual([1, 2]);
    expect(String(errors[0])).toMatch(/consumer bug/);
  });

  it("hands every dead letter to onDeadLetter, with why", async () => {
    const dead: Array<[string, string]> = [];
    const transport = inMemoryTransport({ onDeadLetter: (message, reason) => dead.push([message.id, reason]) });
    await transport.subscribe("orders", collect([], "dead-letter"));

    await transport.publish("orders", { id: "o-1", body: {} });

    expect(dead).toEqual([["o-1", "rejected"]]);
    expect(transport.deadLetters[0]?.headers[DEAD_LETTER_REASON_HEADER]).toBe("rejected");
  });

  it("keeps the latest `retain` messages for a group that subscribes later", async () => {
    const transport = inMemoryTransport({ retain: 2 });
    for (const id of ["o-1", "o-2", "o-3"]) await transport.publish("orders", { id, body: {} });
    const received: Message[] = [];

    await transport.subscribe("orders", collect(received), { group: "late" });
    await transport.drain();

    expect(received.map((message) => message.id)).toEqual(["o-2", "o-3"]);
    expect(transport.published.map((message) => message.id)).toEqual(["o-2", "o-3"]);
  });
});
