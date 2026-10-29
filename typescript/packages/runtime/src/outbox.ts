import { Result, type AnyContracts, type Application, type Clock, type InfrastructureError } from "@projected/application";
import type { StateStore } from "@projected/application/state-based";

/** Thirty days: how long outbox events stay by default once every handler has passed them. */
export const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface OutboxPruningOptions {
  /**
   * How long an event stays in the outbox after it was recorded, even once every event handler
   * has passed it: the window a rebuild or a newly added handler can still replay. Defaults to
   * {@link OUTBOX_RETENTION_MS}.
   */
  readonly retentionMs?: number;
  /** Defaults to the system clock. */
  readonly clock?: Clock;
}

export interface OutboxPrunerOptions extends OutboxPruningOptions {
  /** How often to prune. Defaults to an hour. */
  readonly intervalMs?: number;
  /** Called after a pruning that deleted events, with how many. */
  readonly onPruned?: (count: number) => void;
  /** Called when the outbox could not be pruned; pruning is tried again after the interval. */
  readonly onError?: (error: InfrastructureError) => void;
}

export interface OutboxPruner {
  /** Prune once, now. */
  prune(): Promise<Result<number, InfrastructureError>>;
  /** Stop pruning and wait for a pruning in flight. */
  stop(): Promise<void>;
}

/**
 * Delete the outbox events that every one of the application's event handlers has passed and
 * that are older than the retention, once; returns how many. The handlers include the relays
 * that publish events to a broker, so nothing is deleted before it was delivered. Every reader
 * of this outbox must be one of `app`'s handlers: a reader the app does not know about is not
 * waited for.
 */
export async function pruneOutbox<C extends AnyContracts>(
  app: Application<C>,
  store: Pick<StateStore, "pruneOutbox">,
  options: OutboxPruningOptions = {},
): Promise<Result<number, InfrastructureError>> {
  const backlog = await app.backlog();
  if (backlog.isErr()) return Result.err(backlog.error);
  const furthestAll = Math.min(...backlog.value.map((handler) => handler.position));
  const now = (options.clock?.now() ?? new Date()).getTime();
  return store.pruneOutbox({
    // No handlers: nothing reads the outbox, so the retention alone decides.
    upTo: Number.isFinite(furthestAll) ? furthestAll : Number.MAX_SAFE_INTEGER,
    recordedBefore: new Date(now - (options.retentionMs ?? OUTBOX_RETENTION_MS)).toISOString(),
  });
}

/**
 * Keep a state-based service's outbox from growing for ever: {@link pruneOutbox} every
 * `intervalMs`, in the background. Run it in one instance or in all; prunings never conflict.
 */
export function startOutboxPruning<C extends AnyContracts>(
  app: Application<C>,
  store: Pick<StateStore, "pruneOutbox">,
  options: OutboxPrunerOptions = {},
): OutboxPruner {
  let inFlight: Promise<unknown> = Promise.resolve();
  const prune = (): Promise<Result<number, InfrastructureError>> => {
    const pruning = pruneOutbox(app, store, options).then((outcome) => {
      if (outcome.isErr()) options.onError?.(outcome.error);
      else if (outcome.value > 0) options.onPruned?.(outcome.value);
      return outcome;
    });
    inFlight = pruning;
    return pruning;
  };

  const timer = setInterval(() => void prune(), options.intervalMs ?? 60 * 60 * 1000);
  timer.unref();
  return {
    prune,
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  };
}
