import { Result, panic } from "@projected/domain";
import { OperationDefect, defectReason, type InfrastructureError } from "./errors.js";
import { catchUp, type CatchUpReport, type EventHandler, type EventHandlingError } from "./event-handler.js";
import type { CheckpointStore, EventLog } from "./ports.js";
import type { Telemetry } from "./telemetry.js";

export interface EventHandlingOptions {
  readonly handlers: readonly EventHandler[];
  /** Where handlers read events from: the flavour's event store or state store. */
  readonly store: EventLog;
  readonly checkpoints: CheckpointStore;
  /**
   * Which handlers catch up after every successful command, before it responds: all of them
   * (`true`, the default), none (`false`), or those named. Inline gives read-your-writes
   * consistency at the cost of latency, so keep it to read models a caller reads right after
   * writing; relays to a broker belong to a background poller (`startPolling` from
   * `@projected/runtime`), which runs every handler and picks up whatever an inline run left.
   */
  readonly inline?: boolean | readonly string[];
}

/** How far one event handler is behind the log it reads. */
export interface EventHandlerBacklog {
  readonly handler: string;
  /** The global position it has processed up to. */
  readonly position: number;
  /** The oldest event it has yet to process — absent when it is caught up. */
  readonly oldestPending?: { readonly globalPosition: number; readonly recordedAt: string };
}

/** Where a failing handler is reported. */
export interface EventHandlingReporting {
  readonly telemetry: Telemetry;
  readonly onDefect?: ((defect: OperationDefect) => void) | undefined;
  /** For each handler an inline catch-up could not bring up to date; defects go to `onDefect`. */
  readonly onEventHandlingError?: ((error: InfrastructureError, handler: string) => void) | undefined;
}

/** An application's event handlers, caught up one run at a time. */
export interface EventHandling {
  readonly handlers: readonly EventHandler[];
  /** Catch up the inline handlers after a command, reporting failures as they happen. */
  afterCommand(): Promise<void>;
  /** Catch up every handler. Each gets its turn even when another fails; the first failure is returned. */
  catchUp(): Promise<Result<readonly CatchUpReport[], EventHandlingError>>;
  /** Reset a handler, rewind its checkpoint and replay every event to it. */
  rebuild(handler: EventHandler): Promise<Result<CatchUpReport, EventHandlingError>>;
  backlog(): Promise<Result<readonly EventHandlerBacklog[], InfrastructureError>>;
  /** Resolves once no catch-up is queued or running. */
  idle(): Promise<void>;
}

/**
 * The event handling of an application. Each handler's catch-ups and rebuilds run in its own
 * queue, so that concurrent requests never feed it the same events twice and a rebuild never meets
 * a catch-up halfway through a reset.
 */
export function eventHandling(options: EventHandlingOptions | undefined, reporting: EventHandlingReporting): EventHandling {
  const { telemetry } = reporting;
  const handlers = options?.handlers ?? [];
  const inline = options?.inline ?? true;
  if (typeof inline !== "boolean") {
    const unknown = inline.filter((name) => !handlers.some((handler) => handler.name === name));
    if (unknown.length > 0) panic(`createApplication: eventHandling.inline names no event handler: ${unknown.join(", ")}`);
  }
  const inlineHandlers = inline === true ? handlers : inline === false ? [] : handlers.filter((handler) => inline.includes(handler.name));

  // One queue per handler: two runs never feed a handler the same events, while a handler that
  // is slow — a relay waiting on its consumers — never holds up the others.
  const queues = new Map<string, Promise<unknown>>();
  const enqueue = <T>(handler: EventHandler, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(handler.name) ?? Promise.resolve()).then(work);
    queues.set(handler.name, run.catch(() => undefined));
    return run;
  };

  /** A handler that stopped: counted, and a defect reported like any other. */
  const failed = (handler: EventHandler, error: EventHandlingError) => {
    telemetry.count("projected.event_handler.failures", 1, { "projected.event_handler": handler.name, "projected.error.type": error._tag });
    if (OperationDefect.is(error)) reporting.onDefect?.(error);
  };

  /** Catch one handler up. A store that throws is a defect, not a rejection. */
  const catchUpOne = (handler: EventHandler, store: EventLog, checkpoints: CheckpointStore): Promise<Result<CatchUpReport, EventHandlingError>> =>
    catchUp(handler, store, checkpoints, { telemetry }).catch((cause: unknown) => {
      const reason = defectReason(cause);
      return Result.err(
        new OperationDefect({ operation: `event-handler ${handler.name}`, message: `catch-up threw${reason === undefined ? "" : `: ${reason}`}`, cause }),
      );
    });

  const catchUpAll = async (
    selected: readonly EventHandler[],
    onFailure?: (handler: EventHandler, error: EventHandlingError) => void,
  ): Promise<Result<readonly CatchUpReport[], EventHandlingError>> => {
    if (options === undefined) return Result.ok([]);
    // Side by side, each in its own queue: a broken read model must not hold back a relay.
    const reports = await Promise.all(
      selected.map((handler) =>
        enqueue(handler, async () => {
          const report = await catchUpOne(handler, options.store, options.checkpoints);
          if (report.isErr()) {
            failed(handler, report.error);
            onFailure?.(handler, report.error);
          } else if (report.value.handled > 0) {
            telemetry.count("projected.events.handled", report.value.handled, { "projected.event_handler": handler.name });
          }
          return report;
        }),
      ),
    );
    const failure = reports.find((report) => report.isErr());
    return failure === undefined ? Result.ok(reports.map((report) => report.unwrap())) : Result.err(failure.error);
  };

  return {
    handlers,
    afterCommand: async () => {
      if (inlineHandlers.length === 0) return;
      await catchUpAll(inlineHandlers, (handler, error) => {
        if (!OperationDefect.is(error)) reporting.onEventHandlingError?.(error, handler.name);
      });
    },
    catchUp: () => catchUpAll(handlers),
    rebuild: (handler) =>
      enqueue(handler, async (): Promise<Result<CatchUpReport, EventHandlingError>> => {
        if (options === undefined) return Result.ok({ handler: handler.name, handled: 0, position: 0 });
        if (handler.reset !== undefined) {
          const reset = await handler.reset();
          if (reset.isErr()) return Result.err(reset.error);
        }
        const rewound = await options.checkpoints.save(handler.name, 0);
        if (rewound.isErr()) return Result.err(rewound.error);
        const report = await catchUpOne(handler, options.store, options.checkpoints);
        if (report.isErr()) failed(handler, report.error);
        return report;
      }),
    backlog: async () => {
      if (options === undefined) return Result.ok([]);
      const backlogs: EventHandlerBacklog[] = [];
      for (const handler of handlers) {
        const position = await options.checkpoints.load(handler.name);
        if (position.isErr()) return Result.err(position.error);
        const next = await options.store.readAll({ after: position.value, limit: 1 });
        if (next.isErr()) return Result.err(next.error);
        const pending = next.value[0];
        backlogs.push({
          handler: handler.name,
          position: position.value,
          ...(pending === undefined ? {} : { oldestPending: { globalPosition: pending.globalPosition, recordedAt: pending.recordedAt } }),
        });
      }
      return Result.ok(backlogs);
    },
    idle: async () => {
      await Promise.all(queues.values());
    },
  };
}
