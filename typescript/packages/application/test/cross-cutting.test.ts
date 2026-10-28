import { describe, expect, it, vi } from "vitest";
import {
  DependencyUnavailable,
  Panic,
  Result,
  aggregateRepository,
  createApplication,
  defineCommand,
  defineContracts,
  defineEventHandler,
  defineQuery,
  z,
  type CommandHandler,
  type IdempotencyStore,
  type Principal,
} from "@projected/application/event-sourced";
import { inMemoryCheckpointStore, inMemoryEventStore, inMemoryIdempotencyStore } from "@projected/store-memory/event-sourced";
import { principal, recordingTelemetry, sequentialIds } from "@projected/testing/event-sourced";
import { OpenTicket, Ticket, TicketOpened, open } from "./fixtures.js";

const admin = principal("u-admin", ["tickets:open", "tickets:close"]);
const reader = principal("u-reader");

describe("access", () => {
  const Open = defineCommand({
    type: "open-ticket",
    input: z.object({ title: z.string().min(1) }),
    output: z.object({}),
    access: { permissions: ["tickets:open"] },
  });
  const Count = defineQuery({ type: "ticket-count", input: z.object({}), output: z.object({ count: z.number() }) });
  const Status = defineQuery({ type: "status", input: z.object({}), output: z.object({}), access: "public" });
  const app = createApplication(defineContracts({ name: "desk", access: "authenticated", commands: [Open], queries: [Count, Status] }), {
    ids: sequentialIds(),
    commands: { "open-ticket@1": () => Result.ok({}) },
    queries: { "ticket-count@1": () => Result.ok({ count: 3 }), "status@1": () => Result.ok({}) },
  });
  const run = (type: string, kind: "command" | "query", principalOrNone = undefined as typeof admin | undefined, input: unknown = {}) =>
    app.dispatch({ kind, type, version: 1, input, metadata: principalOrNone === undefined ? {} : { principal: principalOrNone } });

  it("lets anyone run a public operation", async () => {
    expect((await run("status", "query")).isOk()).toBe(true);
  });

  it("refuses anonymous callers the service default", async () => {
    const outcome = await run("ticket-count", "query");

    expect(outcome.isErr() && outcome.error._tag).toBe("Unauthenticated");
  });

  it("lets any authenticated principal run an authenticated operation", async () => {
    expect((await run("ticket-count", "query", reader)).unwrap()).toEqual({ status: "ok", value: { count: 3 } });
  });

  it("refuses a principal without a required permission, naming it", async () => {
    const outcome = await run("open-ticket", "command", reader, { title: "x" });

    expect(outcome.isErr() && outcome.error._tag === "Forbidden" && outcome.error.missing).toEqual(["tickets:open"]);
  });

  it("checks access before validating input, so refused callers learn nothing about it", async () => {
    const outcome = await run("open-ticket", "command", undefined, { nonsense: true });

    expect(outcome.isErr() && outcome.error._tag).toBe("Unauthenticated");
  });

  it("runs the operation for a principal with every permission", async () => {
    expect((await run("open-ticket", "command", admin, { title: "x" })).isOk()).toBe(true);
  });

  it("must be decided for every service", () => {
    // @ts-expect-error — access is required
    expect(() => defineContracts({ name: "careless", commands: [Open] })).toThrow();
  });

  it("must name permissions sensibly", () => {
    expect(() => defineQuery({ type: "x", input: z.object({}), output: z.object({}), access: { permissions: [] } })).toThrow(Panic);
    expect(() =>
      defineQuery({ type: "x", input: z.object({}), output: z.object({}), access: { permissions: ["Open Tickets"] } }),
    ).toThrow(/students:enlist/);
  });
});

describe("duplicate command protection", () => {
  const Charge = defineCommand({
    type: "charge-card",
    input: z.object({ amount: z.number() }),
    output: z.object({ chargeId: z.string() }),
  });
  const Balance = defineQuery({ type: "balance", input: z.object({}), output: z.object({ total: z.number() }) });
  const contracts = defineContracts({ name: "payments", access: "public", commands: [Charge], queries: [Balance] });

  function payments(options: { store?: IdempotencyStore; handler?: CommandHandler<typeof Charge> } = {}) {
    const charges: number[] = [];
    const charge: CommandHandler<typeof Charge> =
      options.handler ??
      (async ({ amount }) => {
        charges.push(amount);
        return Result.ok({ chargeId: `ch-${charges.length}` });
      });
    const app = createApplication(contracts, {
      ids: sequentialIds(),
      commands: { "charge-card@1": charge },
      queries: { "balance@1": () => Result.ok({ total: charges.reduce((a, b) => a + b, 0) }) },
      idempotency: { store: options.store ?? inMemoryIdempotencyStore() },
    });
    const send = (amount: number, idempotencyKey?: string, who: Principal | "anonymous" = reader) =>
      app.dispatch({
        kind: "command",
        type: "charge-card",
        version: 1,
        input: { amount },
        metadata: { idempotencyKey, ...(who === "anonymous" ? {} : { principal: who }) },
      });
    return { app, charges, send };
  }

  it("runs a command once per key and replays its outcome", async () => {
    const { charges, send } = payments();

    const first = await send(10, "key-1");
    const retry = await send(10, "key-1");

    expect(charges).toEqual([10]);
    expect(retry.unwrap()).toEqual(first.unwrap());
  });

  it("runs commands without a key every time", async () => {
    const { charges, send } = payments();

    await send(10);
    await send(10);

    expect(charges).toEqual([10, 10]);
  });

  it("refuses a key reused for a different request", async () => {
    const { charges, send } = payments();
    await send(10, "key-1");

    const reused = await send(99, "key-1");

    expect(reused.isErr() && reused.error._tag).toBe("IdempotencyKeyReused");
    expect(charges).toEqual([10]);
  });

  it("answers a concurrent duplicate with RequestInProgress", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { send } = payments({
      handler: async () => {
        await gate;
        return Result.ok({ chargeId: "ch-1" });
      },
    });

    const first = send(10, "key-1");
    const second = await send(10, "key-1");
    release();

    expect(second.isErr() && second.error._tag).toBe("RequestInProgress");
    expect((await first).isOk()).toBe(true);
  });

  it("lets a command that failed for infrastructure reasons be retried with the same key", async () => {
    let calls = 0;
    const { send } = payments({
      handler: async () =>
        ++calls === 1
          ? Result.err(new DependencyUnavailable({ dependency: "bank", message: "down" }))
          : Result.ok({ chargeId: "ch-2" }),
    });

    const failed = await send(10, "key-1");
    const retried = await send(10, "key-1");

    expect(failed.isErr()).toBe(true);
    expect(retried.unwrap()).toEqual({ status: "ok", value: { chargeId: "ch-2" } });
  });

  it("scopes keys to the principal, so one caller never receives another's outcome", async () => {
    const { charges, send } = payments();

    await send(10, "key-1", reader);
    await send(10, "key-1", admin);

    expect(charges).toEqual([10, 10]);
  });

  it("refuses a short key from an anonymous caller, whose keys all share one scope", async () => {
    const { charges, send } = payments();

    const refused = await send(10, "key-1", "anonymous");

    expect(refused.isErr() && refused.error._tag).toBe("InvalidInput");
    expect(refused.isErr() && refused.error.message).toMatch(/at least 16 characters: send a random UUID/);
    expect(charges).toEqual([]);
  });

  it("protects an anonymous caller's command under a key too long to guess", async () => {
    const { charges, send } = payments();
    const key = "6f0c7e0a-2b1d-4c5e-9a3f-0d8e7b6a5c4d";

    await send(10, key, "anonymous");
    await send(10, key, "anonymous");

    expect(charges).toEqual([10]);
  });

  it("ignores keys on queries, which are safe to repeat", async () => {
    const claim = vi.fn();
    const { app } = payments({ store: { ...inMemoryIdempotencyStore(), claim } });

    await app.dispatch({ kind: "query", type: "balance", version: 1, input: {}, metadata: { idempotencyKey: "key-1" } });

    expect(claim).not.toHaveBeenCalled();
  });

  it("reports an unreachable idempotency store instead of running the command unprotected", async () => {
    const down = inMemoryIdempotencyStore();
    const { charges, send } = payments({
      store: { ...down, claim: async () => Result.err(new DependencyUnavailable({ dependency: "redis", message: "down" })) },
    });

    const outcome = await send(10, "key-1");

    expect(outcome.isErr() && outcome.error._tag).toBe("DependencyUnavailable");
    expect(charges).toEqual([]);
  });
});

describe("tracing", () => {
  function tracedTickets() {
    const telemetry = recordingTelemetry();
    const store = inMemoryEventStore();
    const repository = aggregateRepository(Ticket, store, { telemetry });
    const seen: string[] = [];
    const projection = defineEventHandler({
      name: "ticket-titles",
      events: [TicketOpened],
      handle: {
        TicketOpened: ({ data }) => {
          seen.push(data.title);
          return Result.ok(undefined);
        },
      },
    });
    const app = createApplication(defineContracts({ name: "tickets", access: "authenticated", commands: [OpenTicket] }), {
      ids: sequentialIds("msg"),
      telemetry,
      commands: {
        "open-ticket@1": async (input, context) =>
          (await repository.execute(input.ticketId, (state) => open(state, input), context)).map(() => ({
            ticketId: input.ticketId,
          })),
      },
      eventHandling: { handlers: [projection], store, checkpoints: inMemoryCheckpointStore() },
    });
    return { app, store, telemetry, seen };
  }

  it("records a span per operation with its outcome", async () => {
    const { app, telemetry } = tracedTickets();

    await app.execute(OpenTicket, { ticketId: "t-1", title: "Printer" }, { principal: admin });
    await app.execute(OpenTicket, { ticketId: "t-1", title: "Again" }, { principal: admin });

    expect(telemetry.named("command open-ticket@1").map((span) => span.attributes["projected.outcome"])).toEqual(["ok", "error"]);
    expect(telemetry.named("command open-ticket@1")[1]?.attributes["projected.error.type"]).toBe("TicketAlreadyOpened");
  });

  it("names the message on the span, including an id generated because the transport sent none", async () => {
    const { app, telemetry } = tracedTickets();

    await app.execute(OpenTicket, { ticketId: "t-1", title: "Printer" }, { principal: admin });

    const span = telemetry.named("command open-ticket@1")[0];
    expect(span?.attributes["projected.message_id"]).toBe("msg-1");
    expect(span?.attributes["projected.correlation_id"]).toBe("msg-1");
  });

  it("marks protocol failures as failed spans", async () => {
    const { app, telemetry } = tracedTickets();

    await app.execute(OpenTicket, { ticketId: "t-1", title: "Printer" });

    expect(telemetry.named("command open-ticket@1")[0]?.failures).toHaveLength(1);
  });

  it("records who acted and which trace caused each event", async () => {
    const { app, store, telemetry } = tracedTickets();

    await app.execute(OpenTicket, { ticketId: "t-1", title: "Printer" }, { principal: admin });

    const dispatch = telemetry.named("command open-ticket@1")[0];
    expect(store.all[0]?.metadata).toMatchObject({
      principalId: "u-admin",
      trace: { traceparent: `00-${dispatch?.traceId}-${dispatch?.spanId}-01` },
    });
  });

  it("continues the command's trace in the projections its events feed", async () => {
    const { app, telemetry, seen } = tracedTickets();

    await app.execute(OpenTicket, { ticketId: "t-1", title: "Printer" }, { principal: admin });

    const dispatch = telemetry.named("command open-ticket@1")[0];
    const projection = telemetry.named("ticket-titles TicketOpened")[0];
    expect(seen).toEqual(["Printer"]);
    expect(projection?.traceId).toBe(dispatch?.traceId);
    expect(projection?.parentSpanId).toBe(dispatch?.spanId);
  });

  it("traces repository work inside the operation", async () => {
    const { app, telemetry } = tracedTickets();

    await app.execute(OpenTicket, { ticketId: "t-1", title: "Printer" }, { principal: admin });

    const dispatch = telemetry.named("command open-ticket@1")[0];
    const execute = telemetry.named("execute ticket")[0];
    expect(execute?.parentSpanId).toBe(dispatch?.spanId);
    expect(execute?.attributes).toMatchObject({ "projected.stream": "ticket-t-1", "projected.attempts": 1, "projected.events": 1 });
    expect(telemetry.named("load ticket")[0]?.parentSpanId).toBe(execute?.spanId);
  });
});
