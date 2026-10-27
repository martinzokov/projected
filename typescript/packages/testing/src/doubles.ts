import type { Clock, IdGenerator } from "@projected/application";

/** A clock that only moves when told to. */
export interface FixedClock extends Clock {
  set(instant: string | Date): void;
  advance(milliseconds: number): void;
}

export function fixedClock(start: string | Date = "2024-01-01T00:00:00.000Z"): FixedClock {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set: (instant) => {
      current = new Date(instant);
    },
    advance: (milliseconds) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

/** Ids `prefix-1`, `prefix-2`, ... — predictable in assertions. */
export function sequentialIds(prefix = "id"): IdGenerator {
  let counter = 0;
  return { next: () => `${prefix}-${++counter}` };
}
