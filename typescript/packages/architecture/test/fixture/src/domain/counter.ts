import { Result, defineAggregate, defineError, defineEvent, z, type Decision } from "@projected/domain";

export class CounterAtLimit extends defineError("CounterAtLimit", { schema: z.object({ limit: z.number() }) }) {}

export const Incremented = defineEvent("Incremented", { schema: z.object({ by: z.number() }) });

export const Counter = defineAggregate({
  name: "counter",
  initialState: (): number => 0,
  events: [Incremented],
  evolve: { Incremented: (value, { by }) => value + by },
});

export const increment = (value: number, limit: number): Decision<typeof Counter, CounterAtLimit> =>
  value >= limit ? Result.err(new CounterAtLimit({ limit })) : Result.ok([Incremented({ by: 1 })]);
