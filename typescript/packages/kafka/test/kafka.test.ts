import { afterAll, describe, expect, it } from "vitest";
import { Result, createApplication, defineCommand, defineContracts, z } from "@projected/application";
import { kafkaTransport } from "@projected/kafka";
import { commandQueue, consumeCommands } from "@projected/messaging";
import { messageTransportConformance, principal, sequentialIds } from "@projected/testing";

/**
 * Runs against a real Kafka. Set PROJECTED_TEST_KAFKA_BROKERS to enable, e.g.
 *   docker run -d -p 9092:9092 apache/kafka:4.1.0
 *   PROJECTED_TEST_KAFKA_BROKERS=localhost:9092 pnpm test
 */
const brokers = process.env.PROJECTED_TEST_KAFKA_BROKERS?.split(",");
const transports: Array<ReturnType<typeof kafkaTransport>> = [];
const create = () => {
  const transport = kafkaTransport({ brokers: brokers ?? [], maxAttempts: 3, retryDelayMs: () => 20 });
  transports.push(transport);
  return transport;
};
afterAll(async () => {
  await Promise.all(transports.map((transport) => transport.close()));
});

const suite = brokers === undefined ? describe.skip : describe;

suite("kafka", () => {
  messageTransportConformance("kafka", { create: () => ({ transport: create() }), maxAttempts: 3, durable: true, timeoutMs: 30_000 });

  it("carries queued commands from one service to another", async () => {
    const transport = create();
    const Notify = defineCommand({ type: "notify-parent", input: z.object({ studentId: z.string() }), output: z.object({}) });
    const contracts = defineContracts({ name: "notifications", access: "authenticated", commands: [Notify] });
    const notified: Array<[string, string | undefined]> = [];
    const app = createApplication(contracts, {
      ids: sequentialIds(),
      commands: {
        "notify-parent@1": ({ studentId }, context) => {
          notified.push([studentId, context.metadata.principal?.id]);
          return Result.ok({});
        },
      },
    });
    const topic = `notifications.commands.${Date.now()}`;
    await consumeCommands(app, transport, { topic });
    const context = { metadata: { messageId: "m", correlationId: "c", causationId: undefined, idempotencyKey: undefined, principal: principal("u-1") } };

    (await commandQueue(contracts, transport, { topic, ids: sequentialIds("cmd") }).enqueue(Notify, { studentId: "s-1" }, context)).unwrap();
    const deadline = Date.now() + 30_000;
    while (notified.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notified).toEqual([["s-1", "u-1"]]);
  }, 40_000);
});
