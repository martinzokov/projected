import { z } from "@projected/domain/event-sourced";

/**
 * Money is an integer count of the currency's minor unit — cents, pence — never a float, so
 * that every sum is exact. One movement is at most a billion in the major unit, so that no
 * balance comes near the 2^53 where JavaScript numbers stop being exact.
 */
export const Amount = z.number().int().positive().max(100_000_000_000);

/** An account holds one currency, named by its ISO 4217 code. */
export const Currency = z.string().regex(/^[A-Z]{3}$/, "an ISO 4217 code, such as EUR");
