import { describe, expect, it } from "vitest";
import { defineCommand, defineContracts, defineError, defineQuery, z } from "@projected/application";
import { compareLock, fingerprint, lockOf, updateLock } from "@projected/cli";

class SeatTaken extends defineError("SeatTaken", { schema: z.object({ seat: z.string() }) }) {}
class SeatTakenV2 extends defineError("SeatTaken", { schema: z.object({ seat: z.string(), row: z.number() }) }) {}

const reserve = (overrides: Partial<Parameters<typeof defineCommand>[0]> = {}) =>
  defineCommand({
    type: "reserve-seat",
    input: z.object({ seat: z.string() }),
    output: z.object({ reservationId: z.string() }),
    errors: [SeatTaken],
    ...overrides,
  });
const seats = defineQuery({ type: "free-seats", input: z.object({}), output: z.object({ seats: z.array(z.string()) }) });

describe("fingerprint", () => {
  it("ignores documentation", () => {
    const documented = reserve({
      summary: "Reserve a seat",
      description: "Holds the seat for ten minutes.",
      input: z.object({ seat: z.string().describe("Seat label, e.g. 12C") }),
    });

    expect(fingerprint(documented)).toBe(fingerprint(reserve()));
  });

  it.each([
    ["a new input field", { input: z.object({ seat: z.string(), vip: z.boolean() }) }],
    ["a tighter input rule", { input: z.object({ seat: z.string().min(2) }) }],
    ["a different output", { output: z.object({ reservationId: z.number() }) }],
    ["a new declared error", { errors: [SeatTaken, defineError("SoldOut")] }],
    ["different error data", { errors: [SeatTakenV2] }],
  ])("changes with %s", (_name, overrides) => {
    expect(fingerprint(reserve(overrides as never))).not.toBe(fingerprint(reserve()));
  });
});

describe("lock", () => {
  const v1 = defineContracts({ name: "cinema", commands: [reserve()], queries: [seats] });

  it("records every operation", () => {
    expect(Object.keys(lockOf(v1).operations)).toEqual(["command reserve-seat@1", "query free-seats@1"]);
  });

  it("accepts new versions next to published ones", () => {
    const v2 = defineContracts({
      name: "cinema",
      commands: [reserve(), reserve({ version: 2, input: z.object({ seat: z.string(), row: z.number() }) })],
      queries: [seats],
    });

    expect(compareLock(lockOf(v1), v2)).toEqual({ added: ["command reserve-seat@2"], changed: [], removed: [] });
  });

  it("detects a published operation that changed", () => {
    const edited = defineContracts({ name: "cinema", commands: [reserve({ output: z.object({}) })], queries: [seats] });

    expect(compareLock(lockOf(v1), edited).changed).toEqual(["command reserve-seat@1"]);
  });

  it("detects removals, and only drops them when allowed", () => {
    const shrunk = defineContracts({ name: "cinema", commands: [reserve()] });

    expect(compareLock(lockOf(v1), shrunk).removed).toEqual(["query free-seats@1"]);
    expect(Object.keys(updateLock(lockOf(v1), shrunk).operations)).toContain("query free-seats@1");
    expect(Object.keys(updateLock(lockOf(v1), shrunk, { allowRemoval: true }).operations)).not.toContain("query free-seats@1");
  });

  it("accepts current fingerprints only when rebaselining", () => {
    const edited = defineContracts({ name: "cinema", commands: [reserve({ output: z.object({}) })], queries: [seats] });

    expect(compareLock(updateLock(lockOf(v1), edited, { rebaseline: true }), edited).changed).toEqual([]);
  });

  it("keeps the published fingerprint of a changed operation on update", () => {
    const edited = defineContracts({ name: "cinema", commands: [reserve({ output: z.object({}) })], queries: [seats] });

    expect(updateLock(lockOf(v1), edited).operations["command reserve-seat@1"]).toBe(lockOf(v1).operations["command reserve-seat@1"]);
  });
});
