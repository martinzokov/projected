/** Anything that takes in work: an HTTP server, a message subscription, a poller, a monitor. */
export type Intake = { stop(): Promise<void> } | { close(): Promise<void> };

export interface ShutdownOptions {
  /** The application: unready at once, then waited on until its work in flight is done. */
  readonly app: { drain(): Promise<void> };
  /** Everything that takes in work, stopped together after `graceMs`. */
  readonly intake?: readonly Intake[];
  /** Release connections — pools, transports — once all work has finished. */
  readonly close?: () => Promise<void>;
  /**
   * Time between turning unready and closing the intake, for load balancers to notice the failing
   * readiness probe and stop sending. Set it to a little more than the probe interval. Defaults to 0.
   */
  readonly graceMs?: number;
  /** Give up and exit with 1 when shutting down takes longer. Defaults to 30 s. */
  readonly timeoutMs?: number;
  /** Signals that start the shutdown. Defaults to SIGINT and SIGTERM; empty to call `shutdown()` yourself. */
  readonly signals?: readonly NodeJS.Signals[];
  /** Defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /** Each step, and anything that failed along the way. */
  readonly log?: (message: string) => void;
}

export interface Shutdown {
  /** Run the shutdown now — the sequence a signal starts. Later calls return the same run. */
  shutdown(reason?: string): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const stop = (intake: Intake) => ("stop" in intake ? intake.stop() : intake.close());

/**
 * Shut down without dropping work, in an order that loses nothing:
 *
 * 1. the application stops reporting ready (`GET /health/ready` answers 503, `draining`);
 * 2. after `graceMs`, the intake closes — servers stop accepting, subscriptions stop receiving,
 *    pollers finish their catch-up;
 * 3. the operations and catch-ups still in flight finish;
 * 4. `close` releases connections, and the process exits with 0 — or 1 if any step failed or
 *    the whole took longer than `timeoutMs`.
 *
 * ```ts
 * shutdownGracefully({ app, intake: [server, poller], close: infrastructure.close, graceMs: 5_000 });
 * ```
 */
export function shutdownGracefully(options: ShutdownOptions): Shutdown {
  const log = options.log ?? (() => undefined);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let running: Promise<void> | undefined;

  const sequence = async (reason: string): Promise<boolean> => {
    log(`shutdown (${reason}): no longer ready`);
    const drained = options.app.drain();
    if ((options.graceMs ?? 0) > 0) await sleep(options.graceMs ?? 0);
    log("shutdown: closing intake");
    const stopped = await Promise.allSettled((options.intake ?? []).map(stop));
    const failures = stopped.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    for (const failure of failures) log(`shutdown: could not close intake: ${String(failure.reason)}`);
    await drained;
    log("shutdown: work in flight finished");
    try {
      await options.close?.();
    } catch (error) {
      log(`shutdown: could not release connections: ${String(error)}`);
      return false;
    }
    return failures.length === 0;
  };

  const shutdown = (reason = "requested") =>
    (running ??= (async () => {
      const timeoutMs = options.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        log(`shutdown: still running after ${timeoutMs} ms, exiting`);
        exit(1);
      }, timeoutMs);
      timer.unref();
      const clean = await sequence(reason).catch((error: unknown) => {
        log(`shutdown: ${String(error)}`);
        return false;
      });
      clearTimeout(timer);
      exit(clean ? 0 : 1);
    })());

  for (const signal of options.signals ?? (["SIGINT", "SIGTERM"] as const)) process.once(signal, () => void shutdown(signal));
  return { shutdown };
}
