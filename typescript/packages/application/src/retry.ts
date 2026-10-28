import type { Result } from "@projected/domain";
import { ConcurrencyConflict } from "./errors.js";
import type { Span } from "./telemetry.js";

/**
 * Run a repository's load–decide–save cycle again while it conflicts, at most `maxAttempts` times
 * in all, and record on `span` how many it took and how many events the last one produced.
 */
export async function retryOnConflict<T extends { readonly events: readonly unknown[] }, E>(
  attempt: () => Promise<Result<T, E>>,
  maxAttempts: number,
  span: Span,
): Promise<Result<T, E>> {
  let tries = 1;
  let outcome = await attempt();
  for (; tries < maxAttempts && outcome.isErr() && ConcurrencyConflict.is(outcome.error); tries++) outcome = await attempt();
  span.setAttributes({ "projected.attempts": tries, "projected.events": outcome.isOk() ? outcome.value.events.length : 0 });
  if (outcome.isErr() && ConcurrencyConflict.is(outcome.error)) span.fail(outcome.error.message);
  return outcome;
}
