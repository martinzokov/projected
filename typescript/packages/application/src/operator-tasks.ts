import { Result, panic, z } from "@projected/domain";
import { checkAccess } from "./access.js";
import { InvalidInput, OperationDefect, UnknownTask, defectReason, type OperateError } from "./errors.js";
import type { EventHandling } from "./event-handling.js";
import { OPERATE, defineOperatorTask, type OperatorTask } from "./operator.js";
import type { Metadata } from "./ports.js";
import type { Telemetry } from "./telemetry.js";
import { toValidationIssues } from "./wire.js";

export interface OperatorTasksOptions {
  /** The service's name, for spans and counts. */
  readonly service: string;
  readonly telemetry: Telemetry;
  readonly events: EventHandling;
  /** Tasks beyond the built-in ones. */
  readonly tasks: readonly OperatorTask[];
  /** The metadata a task runs with, completed from what the caller sent. */
  readonly metadata: (given: Partial<Metadata> | undefined) => Metadata;
  readonly onDefect?: ((defect: OperationDefect) => void) | undefined;
}

/**
 * The service's operator tasks — the built-in `list-tasks`, `backlog` and `rebuild`, and its
 * own — and the one way to run them: for a principal with `projected:operate`, validated, traced
 * and counted like an operation.
 */
export function operatorTasks(options: OperatorTasksOptions) {
  const { telemetry, events } = options;

  const noSuchHandler = (name: string) => {
    const names = events.handlers.map((handler) => handler.name);
    const message = names.length === 0 ? "This service has no event handlers" : `No event handler ${name}; there are: ${names.join(", ")}`;
    return new InvalidInput({ issues: [{ path: ["handler"], message, code: undefined }], message });
  };

  const builtIn: OperatorTask[] = [
    defineOperatorTask({
      name: "list-tasks",
      description: "The operator tasks this service offers, with the input each takes.",
      input: z.object({}),
      run: () =>
        Result.ok({
          tasks: [...tasks.values()].map((task) => ({
            name: task.name,
            description: task.description,
            input: z.toJSONSchema(task.input, { io: "input", unrepresentable: "any" }),
          })),
        }),
    }),
    defineOperatorTask({
      name: "backlog",
      description: "Each event handler's checkpoint, and the oldest event it has yet to process.",
      input: z.object({}),
      run: async () => (await events.backlog()).map((handlers) => ({ handlers })),
    }),
    defineOperatorTask({
      name: "rebuild",
      description:
        "Replay every event to one event handler from the start, after its reset if it has one: rebuilds a read model. " +
        "Stop the other instances' event handling first, so none moves the checkpoint meanwhile.",
      input: z.object({ handler: z.string() }),
      run: ({ handler: name }) => {
        const handler = events.handlers.find((candidate) => candidate.name === name);
        return handler === undefined ? Result.err(noSuchHandler(name)) : events.rebuild(handler);
      },
    }),
  ];
  const tasks = new Map<string, OperatorTask>();
  for (const task of [...builtIn, ...options.tasks]) {
    if (tasks.has(task.name)) panic(`createApplication: two operator tasks are named ${task.name}`);
    tasks.set(task.name, task);
  }

  const runTask = async (task: OperatorTask, operation: string, input: unknown, given: Partial<Metadata> | undefined): Promise<Result<unknown, OperateError>> => {
    const denied = checkAccess(operation, { permissions: [OPERATE] }, given?.principal);
    if (denied !== undefined) return Result.err(denied);
    const parsed = task.input.safeParse(input);
    if (!parsed.success) {
      return Result.err(new InvalidInput({ issues: toValidationIssues(parsed.error.issues), message: `Invalid input for ${operation}` }));
    }
    try {
      return await task.run(parsed.data, { metadata: options.metadata(given) });
    } catch (cause) {
      const reason = defectReason(cause);
      const error = new OperationDefect({ operation, message: `task threw${reason === undefined ? "" : `: ${reason}`}`, cause });
      options.onDefect?.(error);
      return Result.err(error);
    }
  };

  return async (name: string, input: unknown, given?: Partial<Metadata>): Promise<Result<unknown, OperateError>> => {
    const task = tasks.get(name);
    if (task === undefined) return Result.err(new UnknownTask({ task: name, message: `No operator task ${name}; list-tasks names the ones there are` }));
    const operation = `task ${name}`;
    return telemetry.span(
      operation,
      { kind: "internal", attributes: { "projected.service": options.service, "projected.task": name, "enduser.id": given?.principal?.id } },
      async (span) => {
        const outcome = await runTask(task, operation, input, given);
        const result = outcome.isOk() ? "ok" : "failed";
        if (outcome.isErr()) span.fail(outcome.error.message);
        span.setAttributes({ "projected.outcome": result, "projected.error.type": outcome.isErr() ? outcome.error._tag : undefined });
        telemetry.count("projected.operator_tasks", 1, {
          "projected.service": options.service,
          "projected.task": name,
          "projected.outcome": result,
          "projected.error.type": outcome.isErr() ? outcome.error._tag : undefined,
        });
        return outcome;
      },
    );
  };
}
