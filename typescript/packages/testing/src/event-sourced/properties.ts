import type { AnyAggregate, AnyEventDefinition, EventOf } from "@projected/application/event-sourced";
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

/** The property every event-sourced aggregate must have: folding any history never throws. */
export function everyHistoryFolds(aggregate: AnyAggregate, options: ForAllOptions & { readonly maxLength?: number } = {}): void {
  forAll([anyHistory(aggregate, options)], (history) => {
    aggregate.fold(history);
  }, options);
}
