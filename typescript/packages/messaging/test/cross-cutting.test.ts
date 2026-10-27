import { describe, expect, it } from "vitest";
import { Result, createApplication, defineCommand, defineContracts, z, type CommandHandler } from "@projected/application";
import { commandQueue, consumeCommands, inMemoryTransport } from "@projected/messaging";
import { inMemoryIdempotencyStore } from "@projected/store-memory";
import { principal, recordingTelemetry, sequentialIds } from "@projected/testing";

const SendInvoice = defineCommand({
  type: "send-invoice",
  input: z.object({ invoiceId: z.string() }),
  output: z.object({}),
  access: { permissions: ["invoices:send"] },
});
const billing = defineContracts({ name: "billing", access: "authenticated", commands: [SendInvoice] });
const clerk = principal("u-clerk", ["invoices:send"]);

function billingService() {
  const sent: Array<{ invoiceId: string; by: string | undefined }> = [];
  const telemetry = recordingTelemetry();
  const sendInvoice: CommandHandler<typeof SendInvoice> = ({ invoiceId }, context) => {
    sent.push({ invoiceId, by: context.metadata.principal?.id });
    return Result.ok({});
  };
  const app = createApplication(billing, {
    ids: sequentialIds("msg"),
    telemetry,
    idempotency: { store: inMemoryIdempotencyStore() },
    commands: { "send-invoice@1": sendInvoice },
  });
  const transport = inMemoryTransport();
  return { app, transport, sent, telemetry };
}

const asClerk = { metadata: { messageId: "web-1", correlationId: "flow-1", causationId: undefined, idempotencyKey: undefined, principal: clerk } };

describe("queued commands", () => {
  it("run with the principal of the code that sent them", async () => {
    const { app, transport, sent } = billingService();
    await consumeCommands(app, transport, { topic: "billing" });

    await commandQueue(billing, transport, { topic: "billing", ids: sequentialIds("cmd") }).enqueue(SendInvoice, { invoiceId: "i-1" }, asClerk);
    await transport.drain();

    expect(sent).toEqual([{ invoiceId: "i-1", by: "u-clerk" }]);
  });

  it("can be run under a fixed service principal instead", async () => {
    const { app, transport, sent } = billingService();
    await consumeCommands(app, transport, { topic: "billing", principal: principal("svc-billing", ["invoices:send"], "service") });

    await commandQueue(billing, transport, { topic: "billing", ids: sequentialIds("cmd") }).enqueue(SendInvoice, { invoiceId: "i-1" });
    await transport.drain();

    expect(sent).toEqual([{ invoiceId: "i-1", by: "svc-billing" }]);
  });

  it("are dead-lettered when access is refused", async () => {
    const { app, transport, sent } = billingService();
    await consumeCommands(app, transport, { topic: "billing" });

    await commandQueue(billing, transport, { topic: "billing", ids: sequentialIds("cmd") }).enqueue(SendInvoice, { invoiceId: "i-1" });
    await transport.drain();

    expect(sent).toEqual([]);
    expect(transport.deadLetters).toHaveLength(1);
  });

  it("run once even when the broker delivers them twice", async () => {
    const { app, transport, sent } = billingService();
    await consumeCommands(app, transport, { topic: "billing" });
    await commandQueue(billing, transport, { topic: "billing", ids: sequentialIds("cmd") }).enqueue(SendInvoice, { invoiceId: "i-1" }, asClerk);
    const original = transport.published[0];

    await transport.publish("billing", { id: original?.id ?? "", body: original?.body });
    await transport.drain();

    expect(sent).toHaveLength(1);
  });

  it("carry the sender's trace to the consumer", async () => {
    const { app, transport, telemetry } = billingService();
    await consumeCommands(app, transport, { topic: "billing" });

    await telemetry.span("web request", {}, () =>
      commandQueue(billing, transport, { topic: "billing", ids: sequentialIds("cmd"), telemetry }).enqueue(SendInvoice, { invoiceId: "i-1" }, asClerk),
    );
    await transport.drain();

    const producer = telemetry.named("send billing/send-invoice@1")[0];
    const consumer = telemetry.named("receive billing")[0];
    const dispatch = telemetry.named("command send-invoice@1")[0];
    expect(consumer).toMatchObject({ traceId: producer?.traceId, parentSpanId: producer?.spanId });
    expect(dispatch?.parentSpanId).toBe(consumer?.spanId);
  });
});
