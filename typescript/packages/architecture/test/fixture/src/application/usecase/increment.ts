import { Result, type AggregateRepository, type CommandHandler } from "@projected/application";
import { Counter, increment } from "../../domain/counter.js";
import type { Increment } from "../port/driving/contracts.js";
import type { Limits } from "../port/driven/limits.js";

export const incrementCounter =
  (deps: { counters: AggregateRepository<typeof Counter>; limits: Limits }): CommandHandler<typeof Increment> =>
  async ({ counterId }, context) =>
    Result.gen(async function* () {
      const limit = yield* Result.await(deps.limits.limitFor(counterId));
      const executed = yield* Result.await(deps.counters.execute(counterId, (value) => increment(value, limit), context));
      return Result.ok({ value: executed.state });
    });
