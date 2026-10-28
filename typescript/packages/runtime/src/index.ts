/**
 * @projected/runtime — real implementations of the framework's own ports, for the composition
 * root. Import it only from `src/infrastructure/**`.
 */
import type { AnyContracts, Application, Clock, EventHandlingError, IdGenerator } from "@projected/application";
import { randomUUID } from "node:crypto";

/** The wall clock. */
export function systemClock(): Clock {
  return { now: () => new Date() };
}

/** Random v4 UUIDs. */
export function randomIds(): IdGenerator {
  return { next: () => randomUUID() };
}

export interface PollingOptions {
  /** Pause between catch-ups that found nothing to do. Defaults to 1000 ms. */
  readonly intervalMs?: number;
  /**
   * Called when a handler could not catch up; polling continues after the interval, and the
   * handler resumes at the failed event. Defects also reach the application's `onDefect`.
   */
  readonly onError?: (error: EventHandlingError) => void;
}

export interface Poller {
  /** Stop polling and wait for an in-flight catch-up to finish. */
  stop(): Promise<void>;
}

/**
 * Run the application's event handlers in the background: catch up, and when there was nothing
 * to do, wait `intervalMs` before checking again. Use it with `eventHandling.inline: false`.
 */
export function startPolling<C extends AnyContracts>(app: Application<C>, options: PollingOptions = {}): Poller {
  const intervalMs = options.intervalMs ?? 1000;
  let stopped = false;
  let wake: (() => void) | undefined;
  const sleep = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const loop = (async () => {
    while (!stopped) {
      const outcome = await app.catchUp();
      if (outcome.isErr()) options.onError?.(outcome.error);
      const busy = outcome.isOk() && outcome.value.some((report) => report.handled > 0);
      if (!busy && !stopped) await sleep();
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}

export { monitorBacklog, type BacklogMonitor, type BacklogMonitorOptions } from "./backlog.js";
export { shutdownGracefully, type Intake, type Shutdown, type ShutdownOptions } from "./shutdown.js";
export { prepareSchema, type PrepareSchemaOptions } from "./schema.js";
