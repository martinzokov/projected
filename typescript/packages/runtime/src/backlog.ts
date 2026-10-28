import type { AnyContracts, Application, Clock, InfrastructureError } from "@projected/application";

export interface BacklogMonitorOptions {
  /** How often to measure. Defaults to 15 s. */
  readonly intervalMs?: number;
  /** Defaults to the system clock. */
  readonly clock?: Clock;
  /** Called when the backlog cannot be read; measuring continues after the interval. */
  readonly onError?: (error: InfrastructureError) => void;
}

export interface BacklogMonitor {
  /** Measure once, now. */
  measure(): Promise<void>;
  /** Stop measuring and wait for a measurement in flight. */
  stop(): Promise<void>;
}

/**
 * Record how far each event handler is behind, as gauges on the application's telemetry:
 *
 * - `projected.event_handler.lag` — seconds since the oldest event it has yet to process was
 *   recorded; 0 when it is caught up. Alert on this.
 * - `projected.event_handler.position` — the global position it has processed up to.
 *
 * In the state-based flavour the outbox is the log handlers read, so an event relay's lag is how
 * long events wait in the outbox before reaching the broker.
 */
export function monitorBacklog<C extends AnyContracts>(app: Application<C>, options: BacklogMonitorOptions = {}): BacklogMonitor {
  const intervalMs = options.intervalMs ?? 15_000;
  const now = () => (options.clock?.now() ?? new Date()).getTime();
  let inFlight: Promise<void> = Promise.resolve();

  const measure = (): Promise<void> => {
    inFlight = (async () => {
      const backlog = await app.backlog();
      if (backlog.isErr()) {
        options.onError?.(backlog.error);
        return;
      }
      for (const { handler, position, oldestPending } of backlog.value) {
        const attributes = { "projected.event_handler": handler };
        const lag = oldestPending === undefined ? 0 : Math.max(0, (now() - Date.parse(oldestPending.recordedAt)) / 1000);
        app.telemetry.gauge("projected.event_handler.lag", lag, attributes);
        app.telemetry.gauge("projected.event_handler.position", position, attributes);
      }
    })();
    return inFlight;
  };

  const timer = setInterval(() => void measure(), intervalMs);
  timer.unref();
  return {
    measure,
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  };
}
