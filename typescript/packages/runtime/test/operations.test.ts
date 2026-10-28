import { describe, expect, it } from "vitest";
import { createApplication, defineContracts, defineEvent, defineEventHandler, Result, z } from "@projected/application/event-sourced";
import { inMemoryCheckpointStore, inMemoryEventStore } from "@projected/store-memory/event-sourced";
import { monitorBacklog, shutdownGracefully, type Intake } from "@projected/runtime";
import { fixedClock, recordingTelemetry, sequentialIds } from "@projected/testing/event-sourced";

const Pinged = defineEvent("Pinged", { schema: z.object({ n: z.number() }) });

function pings() {
  const store = inMemoryEventStore({ clock: fixedClock("2024-03-01T10:00:00.000Z") });
  const telemetry = recordingTelemetry();
  const handler = defineEventHandler({ name: "pings", events: [Pinged], handle: { Pinged: () => Result.ok(undefined) } });
  const app = createApplication(defineContracts({ name: "pings", access: "public" }), {
    ids: sequentialIds(),
    eventHandling: { handlers: [handler], store, checkpoints: inMemoryCheckpointStore(), inline: false },
    telemetry,
  });
  const ping = (n: number) => store.appendToStream(`ping-${n}`, [Pinged.encode(Pinged({ n }))], { expectedVersion: 0 });
  return { app, telemetry, ping };
}

describe("the backlog monitor", () => {
  it("records how long the oldest unprocessed event has waited, and 0 once caught up", async () => {
    const { app, telemetry, ping } = pings();
    await ping(1);
    const monitor = monitorBacklog(app, { clock: fixedClock("2024-03-01T10:01:30.000Z") });

    await monitor.measure();
    const behind = telemetry.gauged("projected.event_handler.lag", { "projected.event_handler": "pings" });
    await app.catchUp();
    await monitor.measure();
    const caughtUp = telemetry.gauged("projected.event_handler.lag", { "projected.event_handler": "pings" });
    await monitor.stop();

    expect(behind).toBe(90);
    expect(caughtUp).toBe(0);
    expect(telemetry.gauged("projected.event_handler.position", { "projected.event_handler": "pings" })).toBe(1);
  });
});

/** A shutdown that records each step instead of exiting. */
function recorded(options: { intake?: Intake[]; close?: () => Promise<void>; timeoutMs?: number; drain?: () => Promise<void> } = {}) {
  const steps: string[] = [];
  const exits: number[] = [];
  const { shutdown } = shutdownGracefully({
    app: { drain: options.drain ?? (async () => void steps.push("drained")) },
    intake: options.intake ?? [],
    close: options.close ?? (async () => void steps.push("closed")),
    signals: [],
    exit: (code) => exits.push(code),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { shutdown, steps, exits };
}

describe("graceful shutdown", () => {
  it("stops the intake, lets work in flight finish, then releases connections and exits with 0", async () => {
    const steps: string[] = [];
    let finishWork = () => {};
    const work = new Promise<void>((resolve) => (finishWork = resolve));
    const { shutdown, exits } = recorded({
      drain: async () => {
        steps.push("unready");
        await work;
        steps.push("drained");
      },
      intake: [
        { close: async () => void steps.push("server closed") },
        { stop: async () => void (steps.push("poller stopped"), finishWork()) },
      ],
      close: async () => void steps.push("closed"),
    });

    await shutdown("SIGTERM");

    expect(steps).toEqual(["unready", "server closed", "poller stopped", "drained", "closed"]);
    expect(exits).toEqual([0]);
  });

  it("runs once, however many signals arrive", async () => {
    const { shutdown, steps, exits } = recorded();

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(steps).toEqual(["drained", "closed"]);
    expect(exits).toEqual([0]);
  });

  it("still finishes the work and closes connections when the intake fails to close, but exits with 1", async () => {
    const { shutdown, steps, exits } = recorded({ intake: [{ close: () => Promise.reject(new Error("socket in use")) }] });

    await shutdown();

    expect(steps).toEqual(["drained", "closed"]);
    expect(exits).toEqual([1]);
  });

  it("exits with 1 when shutting down takes longer than its timeout", async () => {
    const { shutdown, exits } = recorded({ drain: () => new Promise(() => {}), timeoutMs: 20 });

    void shutdown();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(exits).toEqual([1]);
  });
});
