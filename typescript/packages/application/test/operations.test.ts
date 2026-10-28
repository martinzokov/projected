import { describe, expect, it } from "vitest";
import {
  DependencyUnavailable,
  OPERATE,
  Result,
  createApplication,
  defineEventHandler,
  defineOperatorTask,
  z,
  type OperatorTask,
  type ReadinessCheck,
} from "@projected/application/event-sourced";
import { inMemoryCheckpointStore, inMemoryEventStore } from "@projected/store-memory/event-sourced";
import { fixedClock, principal, recordingTelemetry, sequentialIds } from "@projected/testing/event-sourced";
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
function desk(
  options: { readiness?: ReadinessCheck[]; inline?: boolean; slowTitles?: Promise<void>; operatorTasks?: OperatorTask[]; reset?: boolean } = {},
) {
  const store = inMemoryEventStore({ clock: fixedClock("2024-03-01T10:00:00.000Z") });
  const checkpoints = inMemoryCheckpointStore();
  const telemetry = recordingTelemetry();
  const titles: string[] = [];
  const projection = defineEventHandler({
    name: "ticket-titles",
    events: [TicketOpened],
    handle: { TicketOpened: ({ data }) => Result.ok(void titles.push(data.title)) },
    ...(options.reset === true ? { reset: () => Result.ok(void titles.splice(0)) } : {}),
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
    operatorTasks: options.operatorTasks ?? [],
    telemetry,
  });
  return { app, telemetry, checkpoints, titles };
}

const operator = { principal: principal("u-operator", [OPERATE]) };

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

describe("operator tasks", () => {
  it("are refused to callers without the projected:operate permission", async () => {
    const { app } = desk();

    const anonymous = await app.operate("backlog", {});
    const caller = await app.operate("backlog", {}, { principal: principal("u-caller", ["tickets:manage"]) });

    expect(anonymous.isErr() && anonymous.error._tag).toBe("Unauthenticated");
    expect(caller.isErr() && caller.error).toMatchObject({ _tag: "Forbidden", missing: [OPERATE] });
  });

  it("rebuild replays every event to a handler from the start, after its reset", async () => {
    const { app, titles } = desk({ inline: true, reset: true });
    await app.dispatch({ kind: "command", type: "open-ticket", version: 1, input: { ticketId: "t-1", title: "Printer on fire" } });
    await app.dispatch({ kind: "command", type: "open-ticket", version: 1, input: { ticketId: "t-2", title: "Coffee machine" } });
    titles.push("left over from a bug");

    const rebuilt = await app.operate("rebuild", { handler: "ticket-titles" }, operator);

    expect(rebuilt.isOk() && rebuilt.value).toEqual({ handler: "ticket-titles", handled: 2, position: 2 });
    expect(titles).toEqual(["Printer on fire", "Coffee machine"]);
  });

  it("rebuild names the handlers there are when asked for one that is not", async () => {
    const { app } = desk();

    const rebuilt = await app.operate("rebuild", { handler: "ticket-tittles" }, operator);

    expect(rebuilt.isErr() && rebuilt.error).toMatchObject({
      _tag: "InvalidInput",
      issues: [{ path: ["handler"], message: "No event handler ticket-tittles; there are: ticket-titles" }],
    });
  });

  it("list every task with the input it takes, the service's own among the built-in ones", async () => {
    const reindex = defineOperatorTask({
      name: "reindex-search",
      description: "Send every ticket to the search index again.",
      input: z.object({ since: z.iso.date().optional() }),
      run: () => Result.ok({ queued: 0 }),
    });
    const { app } = desk({ operatorTasks: [reindex] });

    const listed = await app.operate("list-tasks", {}, operator);

    const tasks = (listed.unwrap() as { tasks: Array<{ name: string; input: { properties?: object } }> }).tasks;
    expect(tasks.map((task) => task.name)).toEqual(["list-tasks", "backlog", "rebuild", "reindex-search"]);
    expect(Object.keys(tasks[3]?.input.properties ?? {})).toEqual(["since"]);
  });

  it("validate a task's input before running it, and refuse a task that does not exist", async () => {
    const { app } = desk();

    const invalid = await app.operate("rebuild", { handler: 42 }, operator);
    const unknown = await app.operate("rebuild-everything", {}, operator);

    expect(invalid.isErr() && invalid.error._tag).toBe("InvalidInput");
    expect(unknown.isErr() && unknown.error).toMatchObject({ _tag: "UnknownTask", task: "rebuild-everything" });
  });

  it("report a task that throws as a defect, naming why", async () => {
    const broken = defineOperatorTask({
      name: "broken",
      description: "Throws.",
      input: z.object({}),
      run: () => {
        throw new Error("index missing");
      },
    });
    const defects: Error[] = [];
    const app = createApplication(ticketContracts, {
      ids: sequentialIds(),
      commands: { "open-ticket@1": () => Result.ok({ ticketId: "t" }), "close-ticket@1": () => Result.ok({ closed: false }) },
      queries: { "open-ticket-titles@1": () => Result.ok({ titles: [] }) },
      operatorTasks: [broken],
      onDefect: (defect) => defects.push(defect),
    });

    const outcome = await app.operate("broken", {}, operator);

    expect(outcome.isErr() && outcome.error).toMatchObject({ _tag: "OperationDefect", message: "task threw: index missing" });
    expect(defects).toHaveLength(1);
  });

  it("are counted by task and outcome", async () => {
    const { app, telemetry } = desk();

    await app.operate("backlog", {}, operator);
    await app.operate("rebuild", { handler: "nope" }, operator);

    expect(telemetry.counted("projected.operator_tasks", { "projected.task": "backlog", "projected.outcome": "ok" })).toBe(1);
    expect(telemetry.counted("projected.operator_tasks", { "projected.task": "rebuild", "projected.outcome": "failed", "projected.error.type": "InvalidInput" })).toBe(1);
  });
});
