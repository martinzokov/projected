import { defineCommand, defineContracts, z } from "@projected/application";
import { CounterAtLimit } from "../../../domain/counter.js";

export const Increment = defineCommand({
  type: "increment-counter",
  input: z.object({ counterId: z.string() }),
  output: z.object({ value: z.number() }),
  errors: [CounterAtLimit],
});

export const counterContracts = defineContracts({ name: "counters", commands: [Increment] });
