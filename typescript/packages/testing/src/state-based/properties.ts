import { deepStrictEqual } from "node:assert/strict";
import type { AnyAggregate, StateOf } from "@projected/application/state-based";
import { fc, forAll, fromSchema, type ForAllOptions } from "../properties.js";

/** Any valid state of the aggregate — or, unless `existing` is set, none at all (`undefined`). */
export function anyState<A extends AnyAggregate>(aggregate: A, options: { readonly existing: true }): fc.Arbitrary<StateOf<A>>;
export function anyState<A extends AnyAggregate>(aggregate: A, options?: { readonly existing?: boolean }): fc.Arbitrary<StateOf<A> | undefined>;
export function anyState<A extends AnyAggregate>(
  aggregate: A,
  options: { readonly existing?: boolean } = {},
): fc.Arbitrary<StateOf<A> | undefined> {
  const state = fromSchema(aggregate.schema) as fc.Arbitrary<StateOf<A>>;
  return options.existing === true ? state : fc.oneof(fc.constant(undefined), state);
}

/** The property every state-based aggregate must have: any valid state survives storage unchanged. */
export function everyStateRoundTrips(aggregate: AnyAggregate, options: ForAllOptions = {}): void {
  forAll([anyState(aggregate, { existing: true })], (state) => {
    deepStrictEqual(aggregate.decode(aggregate.encode(state)).unwrap(), state);
  }, options);
}
