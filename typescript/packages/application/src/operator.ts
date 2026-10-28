import { panic, type Result, type z } from "@projected/domain";
import type { InfrastructureError, InvalidInput } from "./errors.js";
import type { ExecutionContext } from "./ports.js";

/** The permission every operator task requires. Grant it to operators, never to callers. */
export const OPERATE = "projected:operate";

type MaybePromise<T> = T | Promise<T>;

/**
 * A maintenance task an operator runs on a live service — rebuild a projection, replay dead
 * letters — over HTTP (`POST /operate/{name}`, or `projected operate <name>`). A task requires
 * the {@link OPERATE} permission and is validated, traced and counted like an operation, but it
 * is not one of the service's contracts: no caller may depend on it.
 */
export interface OperatorTask {
  /** kebab-case: `replay-dead-letters`. */
  readonly name: string;
  /** What it does and when to run it, for whoever lists the tasks. */
  readonly description: string;
  readonly input: z.ZodType;
  /** The outcome is shown to the operator as JSON. */
  run(input: unknown, context: ExecutionContext): Promise<Result<unknown, InfrastructureError | InvalidInput>>;
}

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Define an {@link OperatorTask}, its input checked against `input` before it runs. */
export function defineOperatorTask<S extends z.ZodType>(task: {
  readonly name: string;
  readonly description: string;
  readonly input: S;
  run(input: z.output<S>, context: ExecutionContext): MaybePromise<Result<unknown, InfrastructureError | InvalidInput>>;
}): OperatorTask {
  if (!KEBAB_CASE.test(task.name)) panic(`defineOperatorTask: name "${task.name}" must be kebab-case`);
  return {
    name: task.name,
    description: task.description,
    input: task.input,
    run: async (input, context) => task.run(input as z.output<S>, context),
  };
}
