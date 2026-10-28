import { describe, expect, it } from "vitest";
import {
  DependencyUnavailable,
  Result,
  createApplication,
  defineEventHandler,
  type ReadinessCheck,
} from "@projected/application/event-sourced";
import { inMemoryCheckpointStore, inMemoryEventStore } from "@projected/store-memory/event-sourced";
import { fixedClock, recordingTelemetry, sequentialIds } from "@projected/testing/event-sourced";
import { TicketOpened, closeTicket, openTicket, openTicketTitles, ticketContracts, tickets } from "./fixtures.js";

const up = (name: string): ReadinessCheck => ({ name, check: async () => Result.ok(undefined) });
const down = (name: string, message: string): ReadinessCheck => ({
  name,
  check: async () => Result.err(new DependencyUnavailable({ dependency: name, message })),
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** The ticket desk, with event handling run explicitly (`inline: false`) unless told otherwise. */
function desk(options: { readiness?: ReadinessCheck[]; inline?: boolean; slowTitles?: Promise<void> } = {}) {
  const store = inMemoryEventStore({ clock: fixedClock("2024-03-01T10:00:00.000Z") });
  const checkpoints = inMemoryCheckpointStore();
  const telemetry = recordingTelemetry();
  const titles: string[] = [];
  const projection = defineEventHandler({
    name: "ticket-titles",
    events: [TicketOpened],
    handle: { TicketOpened: ({ data }) => Result.ok(void titles.push(data.title)) },
  });
  const repository = tickets(store);
  const app = createApplication(ticketContracts, {
    ids: sequentialIds(),
    commands: { "open-ticket@1": openTicket({ tickets: repository }), "close-ticket@1": closeTicket({ tickets: repository }) },
    queries: {
      "open-ticket-titles@1": async (input, context) => {
        await options.slowTitles;
        return openTicketTitles({ titles: () => titles })(input, context);
      },
    },
    eventHandling: { handlers: [projection], store, checkpoints, inline: options.inline ?? false },
    readiness: options.readiness ?? [],
    telemetry,
  });
  return { app, telemetry, checkpoints };
}

describe("health", () => {
  it("is ready when every readiness check passes", async () => {
    const { app } = desk({ readiness: [up("postgres"), up("kafka")] });

    expect(await app.health()).toEqual({
      status: "ready",
      checks: [
        { name: "postgres", status: "up" },
        { name: "kafka", status: "up" },
      ],
    });
  });

  it("is unready while a dependency is down, saying which and why", async () => {
    const { app } = desk({ readiness: [up("postgres"), down("kafka", "kafka: no broker answered")] });

    expect(await app.health()).toEqual({
      status: "unready",
      checks: [
        { name: "postgres", status: "up" },
        { name: "kafka", status: "down", message: "kafka: no broker answered" },
      ],
    });
  });

  it("counts a check that throws as down, instead of failing the probe", async () => {
    const throwing: ReadinessCheck = { name: "flaky", check: () => Promise.reject(new Error("socket hang up")) };
    const { app } = desk({ readiness: [throwing] });

    expect(await app.health()).toMatchObject({ status: "unready", checks: [{ name: "flaky", status: "down" }] });
  });

  it("reports draining from the moment drain is called, however healthy the dependencies", async () => {
    const { app } = desk({ readiness: [up("postgres")] });

    await app.drain();

    expect((await app.health()).status).toBe("draining");
  });
});

describe("draining", () => {
  it("waits for operations in flight before it resolves", async () => {
    const release = deferred();
    const { app } = desk({ slowTitles: release.promise });
    const query = app.dispatch({ kind: "query", type: "open-ticket-titles", version: 1, input: {} });
    let drained = false;

    const draining = app.drain().then(() => (drained = true));
    await new Promise((resolve) => setImmediate(resolve));
    const beforeRelease = drained;
    release.resolve();
    await draining;

    expect(beforeRelease).toBe(false);
    expect(drained).toBe(true);
    expect((await query).isOk()).toBe(true);
  });
});

describe("backlog", () => {
  it("names the oldest event each handler has yet to process, and nothing once it has caught up", async () => {
    const { app } = desk();
    await app.dispatch({ kind: "command", type: "open-ticket", version: 1, input: { ticketId: "t-1", title: "Printer on fire" } });

    const behind = (await app.backlog()).unwrap();
    await app.catchUp();
    const caughtUp = (await app.backlog()).unwrap();

    expect(behind).toEqual([{ handler: "ticket-titles", position: 0, oldestPending: { globalPosition: 1, recordedAt: "2024-03-01T10:00:00.000Z" } }]);
    expect(caughtUp).toEqual([{ handler: "ticket-titles", position: 1 }]);
  });
});

describe("metrics", () => {
  it("counts operations by type and outcome", async () => {
    const { app, telemetry } = desk({ inline: true });

    await app.dispatch({ kind: "command", type: "open-ticket", version: 1, input: { ticketId: "t-1", title: "Printer on fire" } });
    await app.dispatch({ kind: "command", type: "open-ticket", version: 1, input: { ticketId: "t-1", title: "Again" } });
    await app.dispatch({ kind: "command", type: "open-ticket", version: 1, input: {} });

    const opened = { "projected.operation.type": "open-ticket" };
    expect(telemetry.counted("projected.operations", { ...opened, "projected.outcome": "ok" })).toBe(1);
    expect(telemetry.counted("projected.operations", { ...opened, "projected.outcome": "error", "projected.error.type": "TicketAlreadyOpened" })).toBe(1);
    expect(telemetry.counted("projected.operations", { ...opened, "projected.outcome": "failed", "projected.error.type": "InvalidInput" })).toBe(1);
  });

  it("counts the events each handler handled", async () => {
    const { app, telemetry } = desk({ inline: true });

    await app.dispatch({ kind: "command", type: "open-ticket", version: 1, input: { ticketId: "t-1", title: "Printer on fire" } });
    await app.dispatch({ kind: "command", type: "open-ticket", version: 1, input: { ticketId: "t-2", title: "Coffee machine" } });

    expect(telemetry.counted("projected.events.handled", { "projected.event_handler": "ticket-titles" })).toBe(2);
  });
});
