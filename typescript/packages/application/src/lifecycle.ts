import { Result } from "@projected/domain";
import type { ReadinessCheck } from "./ports.js";

/** Whether the service should be sent traffic, and why not. */
export interface HealthReport {
  /** `ready` when every check passes; `draining` once the application was told to drain. */
  readonly status: "ready" | "unready" | "draining";
  readonly checks: ReadonlyArray<{ readonly name: string; readonly status: "up" | "down"; readonly message?: string }>;
}

/**
 * What an application tells the platform it runs on: whether it is ready, and — once it starts
 * draining — when the work it took in has finished.
 */
export function lifecycle(readiness: readonly ReadinessCheck[], idle: () => Promise<void>) {
  const inFlight = new Set<Promise<unknown>>();
  let draining = false;

  return {
    /** Count `work` as in flight until it settles. */
    track: <T>(work: Promise<T>): Promise<T> => {
      inFlight.add(work);
      // Both callbacks, not `finally`: a derived promise that rejects again would go unhandled
      // and end the process, even though the caller handles `work` itself.
      const settled = () => inFlight.delete(work);
      void work.then(settled, settled);
      return work;
    },

    health: async (): Promise<HealthReport> => {
      const checks = await Promise.all(
        readiness.map(async (check) => {
          const outcome = await check.check().catch((cause: unknown) => Result.err({ message: `check threw: ${String(cause)}` }));
          return outcome.isOk()
            ? { name: check.name, status: "up" as const }
            : { name: check.name, status: "down" as const, message: outcome.error.message };
        }),
      );
      const status = draining ? "draining" : checks.every((check) => check.status === "up") ? "ready" : "unready";
      return { status, checks };
    },

    drain: async (): Promise<void> => {
      draining = true;
      // Work started while waiting is waited for too.
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      await idle();
    },
  };
}
