import { aggregateRepository, createApplication, type EventStore } from "@projected/application";
import { Counter } from "../../domain/counter.js";
import { counterContracts } from "../../application/port/driving/contracts.js";
import { incrementCounter } from "../../application/usecase/increment.js";
import { fixedLimits } from "../adapter/driven/memory/fixed-limits.js";

export const compose = (store: EventStore) =>
  createApplication(counterContracts, {
    ids: { next: () => crypto.randomUUID() },
    commands: {
      "increment-counter@1": incrementCounter({ counters: aggregateRepository(Counter, store), limits: fixedLimits(10) }),
    },
  });
