import type { AnyAggregate, AnyEventDefinition, EventOf } from "@projected/application/event-sourced";
import { expect } from "vitest";
import { fc, forAll, fromSchema, type ForAllOptions } from "../properties.js";

/**
 * Any sequence of the aggregate's events, with valid data — including orders the business would
 * never produce, which is the point: `evolve` must handle whatever is in the store.
 */
export function anyHistory<A extends AnyAggregate>(aggregate: A, options: { readonly maxLength?: number } = {}): fc.Arbitrary<Array<EventOf<A>>> {
  const definitions = aggregate.events as readonly AnyEventDefinition[];
  if (definitions.length === 0) return fc.constant([]);
  const event = fc.oneof(...definitions.map((definition) => fromSchema(definition.schema).map((data) => definition(data) as EventOf<A>)));
  return fc.array(event, { maxLength: options.maxLength ?? 6 });
}

/**
 * The property every event-sourced aggregate must have: folding any history never throws. For
 * an aggregate with snapshots, also that a snapshot of any state it reaches restores that state
 * exactly — through JSON and the snapshot's schema, as a load from a snapshot store would.
 */
export function everyHistoryFolds(aggregate: AnyAggregate, options: ForAllOptions & { readonly maxLength?: number } = {}): void {
  forAll([anyHistory(aggregate, options)], (history) => {
    const state: unknown = aggregate.fold(history);
    if (aggregate.snapshot === undefined) return;
    const restored = aggregate.snapshot.schema.safeParse(JSON.parse(JSON.stringify(state)));
    expect(restored.success ? restored.data : restored.error.issues, `a snapshot of ${aggregate.name}'s state restores it`).toEqual(state);
  }, options);
}
