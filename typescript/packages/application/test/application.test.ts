import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  ConcurrencyConflict,
  DependencyFailure,
  DependencyUnavailable,
  Panic,
  Result,
  aggregateRepository,
  createApplication,
  defineCommand,
  defineContracts,
  defineEventHandler,
  defineQuery,
  inProcessService,
  z,
  type CommandHandler,
  type EventStore,
  type OperationDefect,
} from "@projected/application";
import { inMemoryCheckpointStore, inMemoryEventStore } from "@projected/event-store-memory";
import { sequentialIds } from "@projected/testing";
import {
  CloseTicket,
  OpenTicket,
  OpenTicketTitles,
  Ticket,
  TicketAlreadyOpened,
  TicketClosed,
  TicketNotOpen,
  TicketOpened,
  closeTicket,
  open,
  openTicket,
  openTicketTitles,
  ticketContracts,
  tickets,
} from "./fixtures.js";

function ticketApp(options: { store?: EventStore; onDefect?: (defect: OperationDefect) => void } = {}) {
  const store = options.store ?? inMemoryEventStore();
  const repository = tickets(store);
  const titles: string[] = [];
  const app = createApplication(ticketContracts, {
    ids: sequentialIds("msg"),
    commands: {
      "open-ticket@1": openTicket({ tickets: repository }),
      "close-ticket@1": closeTicket({ tickets: repository }),
    },
    queries: { "open-ticket-titles@1": openTicketTitles({ titles: () => titles }) },
    ...(options.onDefect === undefined ? {} : { onDefect: options.onDefect }),
  });
  return { app, store, titles };
}

describe("contracts", () => {
  it("derive a key from type and version", () => {
    expect(OpenTicket.key).toBe("open-ticket@1");
    expect(defineCommand({ type: "open-ticket", version: 2, input: z.object({}), output: z.object({}) }).key).toBe(
      "open-ticket@2",
    );
  });

  it("must be named in kebab-case", () => {
    expect(() => defineCommand({ type: "OpenTicket", input: z.object({}), output: z.object({}) })).toThrow(Panic);
  });

  it("must use JSON-compatible schemas", () => {
    expect(() => defineQuery({ type: "when", input: z.object({}), output: z.object({ at: z.date() }) })).toThrow(
      /not JSON-compatible/,
    );
  });

  it("cannot list the same operation twice", () => {
    expect(() => defineContracts({ name: "tickets", commands: [OpenTicket, OpenTicket] })).toThrow(/listed twice/);
  });

  it("are found by kind, type and version", () => {
    expect(ticketContracts.find("command", "open-ticket", 1)).toBe(OpenTicket);
    expect(ticketContracts.find("query", "open-ticket", 1)).toBeUndefined();
    expect(ticketContracts.find("command", "open-ticket", 2)).toBeUndefined();
  });
});

describe("dispatch", () => {
  const openRequest = (input: unknown) => ({ kind: "command" as const, type: "open-ticket", version: 1, input });

  it("returns the handler's validated output as an ok result", async () => {
    const { app } = ticketApp();

    const outcome = await app.dispatch(openRequest({ ticketId: "t-1", title: "Printer on fire" }));

    expect(outcome.unwrap()).toEqual({ status: "ok", value: { ticketId: "t-1" } });
  });

  it("returns declared business errors as an error result, not a failure", async () => {
    const { app } = ticketApp();
    await app.dispatch(openRequest({ ticketId: "t-1", title: "Printer on fire" }));

    const outcome = await app.dispatch(openRequest({ ticketId: "t-1", title: "Again" }));

    expect(outcome.unwrap()).toEqual({
      status: "error",
      error: { type: "TicketAlreadyOpened", message: "Ticket t-1 is already open", data: { ticketId: "t-1" } },
    });
  });

  it("fails with UnknownOperation for an unknown type or version", async () => {
    const { app } = ticketApp();

    const outcome = await app.dispatch({ kind: "command", type: "open-ticket", version: 9, input: {} });

    expect(outcome.isErr() && outcome.error._tag).toBe("UnknownOperation");
  });

  it("fails with InvalidInput, listing every issue, before the handler runs", async () => {
    const { app, store } = ticketApp();

    const outcome = await app.dispatch(openRequest({ ticketId: "" }));

    expect(outcome.isErr() && outcome.error._tag).toBe("InvalidInput");
    expect(outcome.isErr() && outcome.error._tag === "InvalidInput" && outcome.error.issues.map((i) => i.path)).toEqual([
      ["ticketId"],
      ["title"],
    ]);
    expect((store as ReturnType<typeof inMemoryEventStore>).all).toHaveLength(0);
  });

  it("passes infrastructure errors through for the transport to map", async () => {
    const down: EventStore = {
      readStream: async () => Result.err(new DependencyUnavailable({ dependency: "db", message: "db down" })),
      appendToStream: async () => Result.err(new DependencyUnavailable({ dependency: "db", message: "db down" })),
      readAll: async () => Result.ok([]),
    };
    const { app } = ticketApp({ store: down });

    const outcome = await app.dispatch(openRequest({ ticketId: "t-1", title: "x" }));

    expect(outcome.isErr() && DependencyUnavailable.is(outcome.error)).toBe(true);
  });

  it("turns a throwing handler into an opaque defect and reports it", async () => {
    const onDefect = vi.fn();
    const Explode = defineCommand({ type: "explode", input: z.object({}), output: z.object({}) });
    const app = createApplication(defineContracts({ name: "bombs", commands: [Explode] }), {
      ids: sequentialIds(),
      onDefect,
      commands: {
        "explode@1": () => {
          throw new Error("boom");
        },
      },
    });

    const outcome = await app.dispatch({ kind: "command", type: "explode", version: 1, input: {} });

    expect(outcome.isErr() && outcome.error._tag).toBe("OperationDefect");
    expect(onDefect).toHaveBeenCalledOnce();
  });

  it("treats output that breaks the contract as a defect", async () => {
    const Lie = defineQuery({ type: "lie", input: z.object({}), output: z.object({ n: z.number() }) });
    const app = createApplication(defineContracts({ name: "liars", queries: [Lie] }), {
      ids: sequentialIds(),
      queries: { "lie@1": () => Result.ok({ n: "not a number" } as unknown as { n: number }) },
    });

    const outcome = await app.dispatch({ kind: "query", type: "lie", version: 1, input: {} });

    expect(outcome.isErr() && outcome.error._tag).toBe("OperationDefect");
  });

  it("treats a business error the contract does not declare as a defect", async () => {
    const Sneaky = defineCommand({ type: "sneaky", input: z.object({}), output: z.object({}) });
    const app = createApplication(defineContracts({ name: "sneaky", commands: [Sneaky] }), {
      ids: sequentialIds(),
      commands: { "sneaky@1": (() => Result.err(new TicketNotOpen({ ticketId: "x" }))) as unknown as CommandHandler<typeof Sneaky> },
    });

    const outcome = await app.dispatch({ kind: "command", type: "sneaky", version: 1, input: {} });

    expect(outcome.isErr() && outcome.error._tag).toBe("OperationDefect");
  });

  it("fills in metadata and passes it to handlers", async () => {
    const seen = vi.fn();
    const Echo = defineQuery({ type: "echo", input: z.object({}), output: z.object({}) });
    const app = createApplication(defineContracts({ name: "echo", queries: [Echo] }), {
      ids: sequentialIds("msg"),
      queries: {
        "echo@1": (_input, context) => {
          seen(context.metadata);
          return Result.ok({});
        },
      },
    });

    await app.dispatch({ kind: "query", type: "echo", version: 1, input: {} });
    await app.dispatch({ kind: "query", type: "echo", version: 1, input: {}, metadata: { correlationId: "flow-7" } });

    expect(seen.mock.calls.map(([m]) => [m.messageId, m.correlationId])).toEqual([
      ["msg-1", "msg-1"],
      ["msg-2", "flow-7"],
    ]);
  });
});

describe("execute", () => {
  it("returns typed output", async () => {
    const { app } = ticketApp();

    const outcome = await app.execute(OpenTicket, { ticketId: "t-1", title: "x" });

    expect(outcome.unwrap()).toEqual({ ticketId: "t-1" });
  });

  it("returns business errors as instances of the contract's error classes", async () => {
    const { app } = ticketApp();

    const outcome = await app.execute(CloseTicket, { ticketId: "missing" });

    expect(outcome.isErr() && TicketNotOpen.is(outcome.error)).toBe(true);
  });
});

describe("aggregateRepository", () => {
  it("appends the decision's events with correlation metadata", async () => {
    const store = inMemoryEventStore();
    const repository = aggregateRepository(Ticket, store);
    const context = { metadata: { messageId: "m-1", correlationId: "c-1", causationId: undefined, idempotencyKey: undefined } };

    const executed = await repository.execute("t-1", (state) => open(state, { ticketId: "t-1", title: "x" }), context);

    expect(executed.unwrap().version).toBe(1);
    expect(store.stream("ticket-t-1").map((e) => [e.type, e.metadata])).toEqual([
      ["TicketOpened", { correlationId: "c-1", causationId: "m-1" }],
    ]);
  });

  it("does not append anything for an empty decision", async () => {
    const store = inMemoryEventStore();
    const repository = aggregateRepository(Ticket, store);
    await repository.execute("t-1", (state) => open(state, { ticketId: "t-1", title: "x" }));
    await repository.execute("t-1", () => Result.ok([TicketClosed({ ticketId: "t-1" })]));

    const again = await repository.execute("t-1", () => Result.ok([]));

    expect(again.unwrap().version).toBe(2);
    expect(store.all).toHaveLength(2);
  });

  it("re-runs the decision on fresh state after a concurrency conflict", async () => {
    const store = inMemoryEventStore();
    const repository = aggregateRepository(Ticket, store);
    let interfered = false;
    const racing: EventStore = {
      ...store,
      appendToStream: async (stream, events, options) => {
        if (!interfered) {
          interfered = true;
          await store.appendToStream(stream, [Ticket.encode(TicketOpened({ ticketId: "t-1", title: "first" }))], options);
        }
        return store.appendToStream(stream, events, options);
      },
    };

    const outcome = await aggregateRepository(Ticket, racing).execute("t-1", (state) =>
      open(state, { ticketId: "t-1", title: "second" }),
    );

    expect(outcome.isErr() && TicketAlreadyOpened.is(outcome.error)).toBe(true);
    expect((await repository.load("t-1")).unwrap().state).toEqual({ status: "open", title: "first" });
  });

  it("gives up with ConcurrencyConflict after maxAttempts", async () => {
    const store = inMemoryEventStore();
    const alwaysConflicting: EventStore = {
      ...store,
      appendToStream: async (stream) =>
        Result.err(new ConcurrencyConflict({ stream, expectedVersion: 0, actualVersion: 1, message: "conflict" })),
    };
    const decide = vi.fn((state: Parameters<typeof open>[0]) => open(state, { ticketId: "t-1", title: "x" }));

    const outcome = await aggregateRepository(Ticket, alwaysConflicting, { maxAttempts: 2 }).execute("t-1", decide);

    expect(outcome.isErr() && ConcurrencyConflict.is(outcome.error)).toBe(true);
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("panics on stored events it cannot decode", async () => {
    const store = inMemoryEventStore();
    await store.appendToStream("ticket-t-1", [{ type: "TicketOpened", schemaVersion: 1, data: { nope: true } }], {
      expectedVersion: 0,
    });

    await expect(aggregateRepository(Ticket, store).load("t-1")).rejects.toThrow(Panic);
  });
});

describe("event handlers", () => {
  const titleProjection = (titles: Map<string, string>) =>
    defineEventHandler({
      name: "open-ticket-titles",
      events: [TicketOpened, TicketClosed],
      handle: {
        TicketOpened: ({ data }) => {
          titles.set(data.ticketId, data.title);
          return Result.ok(undefined);
        },
        TicketClosed: ({ data }) => {
          titles.delete(data.ticketId);
          return Result.ok(undefined);
        },
      },
    });

  function projectedApp(titles: Map<string, string>, inline = true) {
    const store = inMemoryEventStore();
    const checkpoints = inMemoryCheckpointStore();
    const repository = tickets(store);
    const app = createApplication(ticketContracts, {
      ids: sequentialIds(),
      commands: {
        "open-ticket@1": openTicket({ tickets: repository }),
        "close-ticket@1": closeTicket({ tickets: repository }),
      },
      queries: { "open-ticket-titles@1": openTicketTitles({ titles: () => [...titles.values()] }) },
      eventHandling: { handlers: [titleProjection(titles)], store, checkpoints, inline },
    });
    return { app, store, checkpoints };
  }

  it("project inline, so a query right after a command sees its effect", async () => {
    const titles = new Map<string, string>();
    const { app } = projectedApp(titles);

    await app.execute(OpenTicket, { ticketId: "t-1", title: "Printer" });
    await app.execute(OpenTicket, { ticketId: "t-2", title: "Coffee" });
    await app.execute(CloseTicket, { ticketId: "t-1" });

    expect((await app.execute(OpenTicketTitles, {})).unwrap()).toEqual({ titles: ["Coffee"] });
  });

  it("catch up from their checkpoint when run in the background", async () => {
    const titles = new Map<string, string>();
    const { app, checkpoints } = projectedApp(titles, false);
    await app.execute(OpenTicket, { ticketId: "t-1", title: "Printer" });
    expect(titles.size).toBe(0);

    const reports = (await app.catchUp()).unwrap();
    const second = (await app.catchUp()).unwrap();

    expect(reports).toEqual([{ handler: "open-ticket-titles", handled: 1, position: 1 }]);
    expect(second[0]?.handled).toBe(0);
    expect((await checkpoints.load("open-ticket-titles")).unwrap()).toBe(1);
  });

  it("stop at a failing event and resume from it", async () => {
    const store = inMemoryEventStore();
    const checkpoints = inMemoryCheckpointStore();
    const repository = tickets(store);
    await repository.execute("t-1", (s) => open(s, { ticketId: "t-1", title: "a" }));
    await repository.execute("t-2", (s) => open(s, { ticketId: "t-2", title: "b" }));
    let failNext = true;
    const seen: string[] = [];
    const flaky = defineEventHandler({
      name: "flaky",
      events: [TicketOpened],
      handle: {
        TicketOpened: ({ data }) => {
          if (data.ticketId === "t-2" && failNext) {
            failNext = false;
            return Result.err(new DependencyUnavailable({ dependency: "mailer", message: "down" }));
          }
          seen.push(data.ticketId);
          return Result.ok(undefined);
        },
      },
    });
    const app = createApplication(defineContracts({ name: "flaky" }), {
      ids: sequentialIds(),
      eventHandling: { handlers: [flaky], store, checkpoints, inline: false },
    });

    const first = await app.catchUp();
    const second = await app.catchUp();

    expect(first.isErr()).toBe(true);
    expect(second.unwrap()[0]?.position).toBe(2);
    expect(seen).toEqual(["t-1", "t-2"]);
  });
});

describe("inProcessService", () => {
  it("calls the application with the caller's correlation", async () => {
    const { app } = ticketApp();
    const service = inProcessService(app);
    const caller = { metadata: { messageId: "m-9", correlationId: "c-9", causationId: undefined, idempotencyKey: undefined } };

    const outcome = await service.execute(OpenTicket, { ticketId: "t-1", title: "x" }, caller);

    expect(outcome.unwrap()).toEqual({ ticketId: "t-1" });
  });

  it("reports the remote rejecting our input as a dependency failure", async () => {
    const service = inProcessService(ticketApp().app);

    const outcome = await service.execute(OpenTicket, { ticketId: "", title: "" });

    expect(outcome.isErr() && DependencyFailure.is(outcome.error)).toBe(true);
  });
});

describe("compile-time guarantees", () => {
  it("rejects an application missing a handler", () => {
    expect(() =>
      createApplication(ticketContracts, {
        ids: sequentialIds(),
        // @ts-expect-error — "close-ticket@1" is missing
        commands: { "open-ticket@1": openTicket({ tickets: tickets(inMemoryEventStore()) }) },
        queries: { "open-ticket-titles@1": openTicketTitles({ titles: () => [] }) },
      }),
    ).toThrow(/no handler for command close-ticket@1/);
  });

  it("rejects a handler returning an error its contract does not declare", () => {
    // @ts-expect-error — TicketNotOpen is not declared by OpenTicket
    const handler: CommandHandler<typeof OpenTicket> = async () => Result.err(new TicketNotOpen({ ticketId: "x" }));
    void handler;
  });

  it("types execute results from the contract", async () => {
    const { app } = ticketApp();

    const outcome = await app.execute(OpenTicket, { ticketId: "t-1", title: "x" });

    expectTypeOf(outcome.unwrapOr(undefined)).toEqualTypeOf<{ ticketId: string } | undefined>();
    if (outcome.isErr()) expectTypeOf(outcome.error._tag).toEqualTypeOf<
      "TicketAlreadyOpened" | "UnknownOperation" | "InvalidInput" | "OperationDefect" | "ConcurrencyConflict" | "DependencyUnavailable" | "DependencyFailure"
    >();
  });
});
