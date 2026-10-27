import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { createApplication, defineCommand, defineContracts, defineEvent, z } from "@projected/application";
import { inMemoryCheckpointStore, inMemoryEventStore } from "@projected/store-memory";
import { commandQueue, eventRelay, inMemoryTransport } from "@projected/messaging";
import { principal, sequentialIds } from "@projected/testing";

/** The messaging binding must produce exactly the shapes in spec/wire.schema.json. */

const spec = JSON.parse(readFileSync(new URL("../../../../spec/wire.schema.json", import.meta.url), "utf8")) as object;
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(spec);
const conforms = (definition: string, value: unknown) => {
  const validate = ajv.getSchema(`urn:projected:spec:wire:1#/$defs/${definition}`);
  if (validate === undefined) throw new Error(`No $def ${definition}`);
  return validate(value) ? [] : validate.errors;
};

const Ping = defineCommand({ type: "send-ping", input: z.object({ n: z.number() }), output: z.object({}) });
const Pinged = defineEvent("Pinged", { schema: z.object({ n: z.number() }) });

describe("messaging binding conforms to spec/wire.schema.json", () => {
  it("for queued commands", async () => {
    const transport = inMemoryTransport();
    const context = {
      metadata: {
        messageId: "m-1",
        correlationId: "c-1",
        causationId: undefined,
        idempotencyKey: undefined,
        principal: principal("u-1", ["pings:send"]),
      },
    };

    await commandQueue(defineContracts({ name: "pings", access: "public", commands: [Ping] }), transport, { topic: "t", ids: sequentialIds() }).enqueue(
      Ping,
      { n: 1 },
      context,
    );

    expect(conforms("CommandMessage", transport.published[0]?.body)).toEqual([]);
  });

  it("for relayed events", async () => {
    const transport = inMemoryTransport();
    const store = inMemoryEventStore();
    const app = createApplication(defineContracts({ name: "pings", access: "public" }), {
      ids: sequentialIds(),
      eventHandling: { handlers: [eventRelay(transport, { name: "relay", topic: "events" })], store, checkpoints: inMemoryCheckpointStore() },
    });
    await store.appendToStream("ping-1", [Pinged.encode(Pinged({ n: 1 }))], { expectedVersion: 0 });

    await app.catchUp();

    expect(conforms("EventMessage", transport.published[0]?.body)).toEqual([]);
  });
});
