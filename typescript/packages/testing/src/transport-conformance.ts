import { REPLAY_HEADER, deadLetterReplay, deadLetterTopic, type Disposition, type Message, type MessageTransport } from "@projected/messaging";
import { describe, expect, it } from "vitest";

export interface TransportUnderTest {
  readonly transport: MessageTransport;
  /** Deliver what is queued, for transports that only deliver on demand (the in-memory one). */
  readonly drain?: () => Promise<unknown>;
}

export interface TransportConformanceOptions {
  /** Return a transport configured with `maxAttempts` deliveries and short retry delays. */
  readonly create: () => TransportUnderTest | Promise<TransportUnderTest>;
  readonly maxAttempts: number;
  /** Whether messages published before a group first subscribes are still delivered to it. */
  readonly durable: boolean;
  /** How long to wait for asynchronous delivery. Defaults to 15 s. */
  readonly timeoutMs?: number;
}

let topicCounter = 0;
const freshTopic = () => `conformance.${Date.now().toString(36)}.${++topicCounter}`;

/**
 * The behaviour every {@link MessageTransport} adapter must have. Run it from the adapter's test
 * suite against a real broker. Each test uses its own topics.
 */
export function messageTransportConformance(name: string, options: TransportConformanceOptions): void {
  const timeoutMs = options.timeoutMs ?? 15_000;
  // Joining consumer groups can take seconds on real brokers; leave room beyond delivery waits.
  const testTimeout = timeoutMs * 2 + 5_000;

  async function until(condition: () => boolean, under: TransportUnderTest, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      if (under.drain !== undefined) await under.drain();
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const collect = (received: Message[], disposition: (message: Message) => Disposition = () => "ack") =>
    async (message: Message): Promise<Disposition> => {
      received.push(message);
      return disposition(message);
    };

  describe(`MessageTransport conformance: ${name}`, () => {
    it("answers a readiness ping while the broker is reachable", async () => {
      const under = await options.create();

      const pinged = await under.transport.ping();

      expect(pinged.isOk() ? "ok" : pinged.error.message).toBe("ok");
    }, testTimeout);

    it("delivers a published message with its id, key, body and headers", async () => {
      const under = await options.create();
      const topic = freshTopic();
      const received: Message[] = [];
      const subscription = await under.transport.subscribe(topic, collect(received));

      (await under.transport.publish(topic, { id: "m-1", key: "k-1", body: { n: 1 }, headers: { traceparent: "t" } })).unwrap();
      await until(() => received.length === 1, under, "the message");
      await subscription.close();

      expect(received[0]).toMatchObject({ id: "m-1", key: "k-1", topic, body: { n: 1 }, attempt: 1 });
      expect(received[0]?.headers.traceparent).toBe("t");
    }, testTimeout);

    it("redelivers a message the handler asks to retry, counting attempts", async () => {
      const under = await options.create();
      const topic = freshTopic();
      const received: Message[] = [];
      const subscription = await under.transport.subscribe(topic, collect(received, (m) => (m.attempt < 2 ? "retry" : "ack")));

      await under.transport.publish(topic, { id: "m-1", body: {} });
      await until(() => received.length === 2, under, "the redelivery");
      await subscription.close();

      expect(received.map((m) => [m.id, m.attempt])).toEqual([
        ["m-1", 1],
        ["m-1", 2],
      ]);
    }, testTimeout);

    it("dead-letters a message that exhausts its attempts", async () => {
      const under = await options.create();
      const topic = freshTopic();
      const received: Message[] = [];
      const dead: Message[] = [];
      const subscription = await under.transport.subscribe(topic, collect(received, () => "retry"));
      const dlq = await under.transport.subscribe(deadLetterTopic(topic), collect(dead));

      await under.transport.publish(topic, { id: "m-1", body: { n: 1 } });
      await until(() => dead.length === 1, under, "the dead letter");
      await subscription.close();
      await dlq.close();

      expect(received).toHaveLength(options.maxAttempts);
      expect(dead[0]).toMatchObject({ id: "m-1", body: { n: 1 } });
    }, testTimeout);

    it("dead-letters at once a message the handler rejects", async () => {
      const under = await options.create();
      const topic = freshTopic();
      const received: Message[] = [];
      const dead: Message[] = [];
      const subscription = await under.transport.subscribe(topic, collect(received, () => "dead-letter"));
      const dlq = await under.transport.subscribe(deadLetterTopic(topic), collect(dead));

      await under.transport.publish(topic, { id: "m-1", body: {} });
      await until(() => dead.length === 1, under, "the dead letter");
      await subscription.close();
      await dlq.close();

      expect(received).toHaveLength(1);
    }, testTimeout);

    it("gives every consumer group its own copy of each message", async () => {
      const under = await options.create();
      const topic = freshTopic();
      const billing: Message[] = [];
      const shipping: Message[] = [];
      const a = await under.transport.subscribe(topic, collect(billing), { group: "billing" });
      const b = await under.transport.subscribe(topic, collect(shipping), { group: "shipping" });

      await under.transport.publish(topic, { id: "m-1", body: {} });
      await under.transport.publish(topic, { id: "m-2", body: {} });
      await until(() => billing.length === 2 && shipping.length === 2, under, "both groups");
      await a.close();
      await b.close();

      expect([billing.map((m) => m.id), shipping.map((m) => m.id)]).toEqual([
        ["m-1", "m-2"],
        ["m-1", "m-2"],
      ]);
    }, testTimeout);

    it("keeps messages with the same key in order", async () => {
      const under = await options.create();
      const topic = freshTopic();
      const received: Message[] = [];
      const subscription = await under.transport.subscribe(topic, collect(received));

      for (let i = 0; i < 10; i++) await under.transport.publish(topic, { id: `m-${i}`, key: "same", body: { i } });
      await until(() => received.length === 10, under, "ten messages");
      await subscription.close();

      expect(received.map((m) => (m.body as { i: number }).i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }, testTimeout);

    if (options.durable) {
      it("keeps messages published before a group first subscribes", async () => {
        const under = await options.create();
        const topic = freshTopic();
        const received: Message[] = [];
        // Make sure the topic exists, then publish with nobody listening.
        await (await under.transport.subscribe(topic, collect([]), { group: "warm-up" })).close();
        await under.transport.publish(topic, { id: "early", body: {} });

        const subscription = await under.transport.subscribe(topic, collect(received), { group: "late" });
        await until(() => received.length === 1, under, "the earlier message");
        await subscription.close();

        expect(received[0]?.id).toBe("early");
      }, testTimeout);

      it("replays a topic's dead letters to it, under their ids, once", async () => {
        const under = await options.create();
        const topic = freshTopic();
        const received: Message[] = [];
        // Rejected until replayed: the fix has been deployed in between.
        const subscription = await under.transport.subscribe(
          topic,
          collect(received, (message) => (message.headers[REPLAY_HEADER] === undefined ? "dead-letter" : "ack")),
        );
        (await under.transport.publish(topic, { id: "m-replay", body: { n: 1 } })).unwrap();
        await until(() => received.length === 1, under, "the first delivery");
        const replay = deadLetterReplay(under.transport, { topics: [topic], group: `replay-${topic}`, idleMs: Math.min(timeoutMs / 3, 5_000) });
        const run = () => replay.run({ topic }, { metadata: { messageId: "op-1", correlationId: "op-1", causationId: undefined, idempotencyKey: undefined } });

        let settled = false;
        const first = run().finally(() => (settled = true));
        while (!settled) {
          await under.drain?.();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const replayed = await first;
        await until(() => received.length === 2, under, "the replayed message");
        const again = run();
        await under.drain?.();
        const replayedAgain = await again;
        await subscription.close();

        expect(replayed.isOk() && replayed.value).toEqual({ topic, replayed: 1 });
        expect(received.map((message) => [message.id, message.body])).toEqual([
          ["m-replay", { n: 1 }],
          ["m-replay", { n: 1 }],
        ]);
        expect(replayedAgain.isOk() && replayedAgain.value).toEqual({ topic, replayed: 0 });
      }, testTimeout * 2);
    }

    it("delivers a message published again as a replay, though its id was published before", async () => {
      const under = await options.create();
      const topic = freshTopic();
      const received: Message[] = [];
      const subscription = await under.transport.subscribe(topic, collect(received));

      (await under.transport.publish(topic, { id: "m-again", body: {} })).unwrap();
      await until(() => received.length === 1, under, "the message");
      (await under.transport.publish(topic, { id: "m-again", body: {}, headers: { [REPLAY_HEADER]: "replay-1" } })).unwrap();
      await until(() => received.length === 2, under, "the replayed message");
      await subscription.close();

      expect(received.map((message) => message.id)).toEqual(["m-again", "m-again"]);
    }, testTimeout);
  });
}
