import { describe, expect, it, vi } from "vitest";
import {
  ConcurrencyConflict,
  Panic,
  Result,
  aggregateRepository,
  createApplication,
  defineEventHandler,
  remove,
  type StateStore,
} from "@projected/application/state-based";
import { inMemoryCheckpointStore, inMemoryStateStore } from "@projected/store-memory/state-based";
import { recordingTelemetry, sequentialIds } from "@projected/testing/state-based";
import { CloseTicket, OpenTicket, TicketAlreadyOpened, TicketClosed, TicketOpened, ticketContracts } from "./fixtures.js";
import { Ticket, close, closeTicket, open, openTicket } from "./state-based.fixtures.js";

describe("aggregateRepository", () => {
  it("saves the decided state, recording its events with correlation metadata", async () => {
    const store = inMemoryStateStore();
    const repository = aggregateRepository(Ticket, store);
    const context = { metadata: { messageId: "m-1", correlationId: "c-1", causationId: undefined, idempotencyKey: undefined } };

    const executed = await repository.execute("t-1", (state) => open(state, { ticketId: "t-1", title: "x" }), context);

    expect(executed.unwrap()).toMatchObject({ version: 1, state: { status: "open", title: "x" } });
    expect(store.stateOf("ticket-t-1")).toEqual({ schemaVersion: 1, data: { status: "open", title: "x" } });
    expect(store.eventsOf("ticket-t-1").map((e) => [e.type, e.metadata])).toEqual([
      ["TicketOpened", { correlationId: "c-1", causationId: "m-1" }],
    ]);
  });

  it("loads a missing aggregate as absent", async () => {
    const loaded = await aggregateRepository(Ticket, inMemoryStateStore()).load("t-1");

    expect(loaded.unwrap()).toEqual({ id: "t-1", version: 0, state: undefined });
  });

  it("saves nothing when the decision changes nothing", async () => {
    const store = inMemoryStateStore();
    const repository = aggregateRepository(Ticket, store);
    await repository.execute("t-1", (state) => open(state, { ticketId: "t-1", title: "x" }));
    await repository.execute("t-1", (state) => close(state, "t-1"));

    const again = await repository.execute("t-1", (state) => close(state, "t-1"));

    expect(again.unwrap()).toMatchObject({ version: 2, events: [] });
    expect(store.all).toHaveLength(2);
  });

  it("removes the aggregate's state and records the removal's events", async () => {
    const store = inMemoryStateStore();
    const repository = aggregateRepository(Ticket, store);
    await repository.execute("t-1", (state) => open(state, { ticketId: "t-1", title: "x" }));

    const removed = await repository.execute("t-1", () => Result.ok(remove(TicketClosed({ ticketId: "t-1" }))));

    expect(removed.unwrap()).toMatchObject({ version: 2, state: undefined });
    expect((await repository.load("t-1")).unwrap()).toEqual({ id: "t-1", version: 2, state: undefined });
    expect(store.all.map((e) => e.type)).toEqual(["TicketOpened", "TicketClosed"]);
  });

  it("re-runs the decision on fresh state after a concurrency conflict", async () => {
    const store = inMemoryStateStore();
    const repository = aggregateRepository(Ticket, store);
    let interfered = false;
    const racing: StateStore = {
      ...store,
      save: async (key, write, options) => {
        if (!interfered) {
          interfered = true;
          await store.save(key, { state: Ticket.encode({ status: "open", title: "first" }), events: [] }, options);
        }
        return store.save(key, write, options);
      },
    };

    const outcome = await aggregateRepository(Ticket, racing).execute("t-1", (state) =>
      open(state, { ticketId: "t-1", title: "second" }),
    );

    expect(outcome.isErr() && TicketAlreadyOpened.is(outcome.error)).toBe(true);
    expect((await repository.load("t-1")).unwrap().state).toEqual({ status: "open", title: "first" });
  });

  it("gives up with ConcurrencyConflict after maxAttempts", async () => {
    const store = inMemoryStateStore();
    const alwaysConflicting: StateStore = {
      ...store,
      save: async (key) => Result.err(new ConcurrencyConflict({ key, expectedVersion: 0, actualVersion: 1, message: "conflict" })),
    };
    const decide = vi.fn((state: Parameters<typeof open>[0]) => open(state, { ticketId: "t-1", title: "x" }));

    const outcome = await aggregateRepository(Ticket, alwaysConflicting, { maxAttempts: 2 }).execute("t-1", decide);

    expect(outcome.isErr() && ConcurrencyConflict.is(outcome.error)).toBe(true);
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("panics on stored state it cannot decode", async () => {
    const store = inMemoryStateStore();
    await store.save("ticket-t-1", { state: { schemaVersion: 1, data: { nope: true } }, events: [] }, { expectedVersion: 0 });

    await expect(aggregateRepository(Ticket, store).load("t-1")).rejects.toThrow(Panic);
  });
});

describe("a state-based application", () => {
  function ticketDesk() {
    const store = inMemoryStateStore();
    const telemetry = recordingTelemetry();
    const repository = aggregateRepository(Ticket, store, { telemetry });
    const titles = new Map<string, string>();
    const projection = defineEventHandler({
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
    const app = createApplication(ticketContracts, {
      ids: sequentialIds("msg"),
      telemetry,
      commands: {
        "open-ticket@1": openTicket({ tickets: repository }),
        "close-ticket@1": closeTicket({ tickets: repository }),
      },
      queries: { "open-ticket-titles@1": () => Result.ok({ titles: [...titles.values()] }) },
      eventHandling: { handlers: [projection], store, checkpoints: inMemoryCheckpointStore() },
    });
    return { app, store, telemetry, titles };
  }

  it("runs commands through the dispatcher and feeds the outbox to event handlers", async () => {
    const { app, titles } = ticketDesk();

    await app.execute(OpenTicket, { ticketId: "t-1", title: "Printer" });
    await app.execute(OpenTicket, { ticketId: "t-2", title: "Coffee" });
    const closed = await app.execute(CloseTicket, { ticketId: "t-1" });
    const again = await app.execute(CloseTicket, { ticketId: "t-1" });

    expect([closed.unwrap(), again.unwrap()]).toEqual([{ closed: true }, { closed: false }]);
    expect([...titles.values()]).toEqual(["Coffee"]);
  });

  it("returns business errors from decisions as declared outcomes", async () => {
    const { app } = ticketDesk();
    await app.execute(OpenTicket, { ticketId: "t-1", title: "Printer" });

    const outcome = await app.execute(OpenTicket, { ticketId: "t-1", title: "Again" });

    expect(outcome.isErr() && TicketAlreadyOpened.is(outcome.error)).toBe(true);
  });

  it("traces the repository's work under the operation", async () => {
    const { app, telemetry } = ticketDesk();

    await app.execute(OpenTicket, { ticketId: "t-1", title: "Printer" });

    const dispatch = telemetry.named("command open-ticket@1")[0];
    const execute = telemetry.named("execute ticket")[0];
    expect(execute?.parentSpanId).toBe(dispatch?.spanId);
    expect(execute?.attributes).toMatchObject({ "projected.aggregate.key": "ticket-t-1", "projected.attempts": 1, "projected.events": 1 });
  });
});
