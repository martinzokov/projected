import { afterAll, describe, expect, it } from "vitest";
import { Result, createApplication, defineCommand, defineContracts, z } from "@projected/application";
import { natsTransport } from "@projected/nats";
import { commandQueue, consumeCommands } from "@projected/messaging";
import { principal, sequentialIds } from "@projected/testing";
import { messageTransportConformance } from "@projected/testing/messaging";

/**
 * Runs against a real NATS server with JetStream. Set PROJECTED_TEST_NATS_URL to enable, e.g.
 *   docker run -d -p 4222:4222 nats:2.12-alpine -js
 *   PROJECTED_TEST_NATS_URL=nats://localhost:4222 pnpm test
 */
const servers = process.env.PROJECTED_TEST_NATS_URL;
const transports: Array<ReturnType<typeof natsTransport>> = [];
let streams = 0;
const create = () => {
  // A stream per transport keeps tests independent of each other's consumers.
  const run = `${process.pid}_${++streams}`;
  const transport = natsTransport({
    servers: servers ?? "",
    stream: `TEST_${run}`,
    subjectPrefix: `test_${run}`,
    maxAttempts: 3,
    retryDelayMs: () => 20,
  });
  transports.push(transport);
  return transport;
};
afterAll(async () => {
  await Promise.all(transports.map((transport) => transport.close()));
});

describe("nats without a server", () => {
  it("answers a readiness ping with unavailable, within its timeout", async () => {
    const transport = natsTransport({ servers: "nats://127.0.0.1:1", pingTimeoutMs: 500 });
    transports.push(transport);

    const pinged = await transport.ping();

    expect(pinged.isErr() && pinged.error).toMatchObject({ _tag: "DependencyUnavailable", dependency: "nats" });
  }, 5_000);
});

const suite = servers === undefined ? describe.skip : describe;

suite("nats", () => {
  messageTransportConformance("nats", { create: () => ({ transport: create() }), maxAttempts: 3, durable: true });

  it("refuses to share a consumer between two topics whose names sanitise alike", async () => {
    const transport = create();
    const subscription = await transport.subscribe("school.events", async () => "ack", { group: "relay" });

    const clash = transport.subscribe("school_events", async () => "ack", { group: "relay" });

    await expect(clash).rejects.toThrow(/consumer relay__school_events already follows .*school\.events, not .*school_events/);
    await subscription.close();
  });

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
