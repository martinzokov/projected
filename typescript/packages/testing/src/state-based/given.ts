import { deepStrictEqual, fail } from "node:assert/strict";
import type { AnyAggregate, AnyBusinessErrorClass, Change, Decision, EventOf, StateOf } from "@projected/application/state-based";

/** The outcome of running a decision, with assertions that read as the business rule. */
export interface Then<A extends AnyAggregate, E> {
  /** The raw decision, for assertions the helpers below do not cover. */
  readonly decision: Decision<A, E>;
  /** The state the decision ran against; undefined when the aggregate did not exist. */
  readonly state: StateOf<A> | undefined;
  /** Assert the decision stores exactly this state, emitting exactly these events in order. */
  thenChangesTo(state: StateOf<A>, ...events: ReadonlyArray<EventOf<A>>): void;
  /** Assert the decision removes the aggregate, emitting exactly these events in order. */
  thenRemoves(...events: ReadonlyArray<EventOf<A>>): void;
  /** Assert the decision accepted the request but had nothing to change. */
  thenNothingHappens(): void;
  /** Assert the decision was rejected with this error class, optionally checking its data. */
  thenRejectsWith<C extends AnyBusinessErrorClass>(error: C, data?: Partial<InstanceType<C>>): void;
}

export interface When<A extends AnyAggregate> {
  /** Run a decision function against the given state. */
  when<E>(decide: (state: StateOf<A> | undefined) => Decision<A, E>): Then<A, E>;
}

/**
 * Given–when–then for decision functions: no store, no mocks, just the domain.
 *
 * ```ts
 * given(Student, { firstname: "Ada", lastname: "Lovelace", status: "enlisted", ... })
 *   .when((state) => enlist(state, input))
 *   .thenRejectsWith(StudentAlreadyEnlisted);
 *
 * given(Student)                                   // the student does not exist yet
 *   .when((state) => enlist(state, input))
 *   .thenChangesTo({ ... }, StudentEnlisted({ ... }));
 * ```
 *
 * The given state and every state a decision stores go through the aggregate's schema, as they
 * would in a real store, so a test cannot pass with a state production would refuse.
 */
export function given<A extends AnyAggregate>(aggregate: A, state?: StateOf<A>): When<A> {
  if (state !== undefined) aggregate.encode(state);
  return {
    when: (decide) => {
      const decision = decide(state);
      const describe = () =>
        decision.isOk()
          ? `${decision.value.kind} ${JSON.stringify(decision.value)}`
          : `error ${String((decision.error as { _tag?: string })._tag ?? decision.error)}`;
      const expectKind = <K extends Change<A>["kind"]>(kind: K): Extract<Change<A>, { readonly kind: K }> => {
        if (decision.isErr() || decision.value.kind !== kind) fail(`Expected ${kind}, got ${describe()}`);
        return decision.value as Extract<Change<A>, { readonly kind: K }>;
      };
      return {
        decision,
        state,
        thenChangesTo: (expected, ...events) => {
          const actual = expectKind("change");
          aggregate.encode(actual.state);
          deepStrictEqual(actual.state, expected);
          deepStrictEqual(actual.events, events);
        },
        thenRemoves: (...events) => {
          deepStrictEqual(expectKind("remove").events, events);
        },
        thenNothingHappens: () => {
          expectKind("none");
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
