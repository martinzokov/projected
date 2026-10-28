import { deepStrictEqual, fail } from "node:assert/strict";
import type { AnyAggregate, AnyBusinessErrorClass, Decision, EventOf, StateOf } from "@projected/application/event-sourced";

/** The outcome of running a decision, with assertions that read as the business rule. */
export interface Then<A extends AnyAggregate, E> {
  /** The raw decision, for assertions the helpers below do not cover. */
  readonly decision: Decision<A, E>;
  /** The state the decision ran against. */
  readonly state: StateOf<A>;
  /** Assert the decision produced exactly these events, in order. */
  thenEvents(...expected: ReadonlyArray<EventOf<A>>): void;
  /** Assert the decision accepted the request but had nothing to record. */
  thenNothingHappens(): void;
  /** Assert the decision was rejected with this error class, optionally checking its data. */
  thenRejectsWith<C extends AnyBusinessErrorClass>(error: C, data?: Partial<InstanceType<C>>): void;
}

export interface When<A extends AnyAggregate> {
  /** Run a decision function against the state built from the given events. */
  when<E>(decide: (state: StateOf<A>) => Decision<A, E>): Then<A, E>;
}

/**
 * Given–when–then for decision functions: no event store, no mocks, just the domain.
 *
 * ```ts
 * given(Student, [StudentEnlisted({ ... })])
 *   .when((state) => enlist(state, input))
 *   .thenRejectsWith(StudentAlreadyEnlisted);
 * ```
 */
export function given<A extends AnyAggregate>(aggregate: A, history: ReadonlyArray<EventOf<A>> = []): When<A> {
  const state = aggregate.fold(history) as StateOf<A>;
  return {
    when: (decide) => {
      const decision = decide(state);
      const describe = () =>
        decision.isOk()
          ? `events ${JSON.stringify(decision.value)}`
          : `error ${String((decision.error as { _tag?: string })._tag ?? decision.error)}`;
      return {
        decision,
        state,
        thenEvents: (...expected) => {
          if (decision.isErr()) fail(`Expected events, got ${describe()}`);
          deepStrictEqual(decision.value, expected);
        },
        thenNothingHappens: () => {
          if (decision.isErr()) fail(`Expected no events, got ${describe()}`);
          deepStrictEqual(decision.value, []);
        },
        thenRejectsWith: (error, data) => {
          if (decision.isOk()) fail(`Expected ${error.tag}, got ${describe()}`);
          if (!error.is(decision.error)) fail(`Expected ${error.tag}, got ${describe()}`);
          if (data !== undefined) {
            const actual = Object.fromEntries(
              Object.keys(data).map((key) => [key, (decision.error as Record<string, unknown>)[key]]),
            );
            deepStrictEqual(actual, data);
          }
        },
      };
    },
  };
}
