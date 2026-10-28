import { describe, expect, it } from "vitest";
import { z } from "@projected/application";
import * as eventSourced from "@projected/application/event-sourced";
import * as stateBased from "@projected/application/state-based";
import { fc, forAll, fromSchema } from "@projected/testing";
import { anyHistory, everyHistoryFolds } from "@projected/testing/event-sourced";
import { anyState, everyStateRoundTrips } from "@projected/testing/state-based";

const Enrolment = z.object({
  studentId: z.string().trim().min(1),
  email: z.email(),
  joiningDate: z.iso.date(),
  reportedAt: z.iso.datetime(),
  year: z.number().int().min(1).max(13),
  track: z.enum(["science", "arts"]),
  nickname: z.string().max(8).optional(),
  tutor: z.string().nullable(),
  subjects: z.array(z.string().min(2)).max(3),
  ref: z.union([z.uuid(), z.literal("none")]),
});

const sample = <T>(arbitrary: fc.Arbitrary<T>) => fc.sample(arbitrary, { numRuns: 300, seed: 42 });

describe("fromSchema", () => {
  it("generates only values the schema accepts, formats and ranges included", () => {
    const values = sample(fromSchema(Enrolment));

    expect(values.every((value) => Enrolment.safeParse(value).success)).toBe(true);
  });

  it("honours refinements and transforms, not just the JSON Schema", () => {
    const values = sample(fromSchema(Enrolment));

    expect(values.every((value) => value.studentId.trim() === value.studentId && value.studentId.length > 0)).toBe(true);
  });

  it("covers optional and nullable fields both ways", () => {
    const values = sample(fromSchema(Enrolment));

    expect(values.some((value) => value.nickname === undefined) && values.some((value) => value.nickname !== undefined)).toBe(true);
    expect(values.some((value) => value.tutor === null) && values.some((value) => value.tutor !== null)).toBe(true);
  });
});

describe("forAll", () => {
  it("reports the smallest counterexample it can find", () => {
    const check = () => forAll([fc.integer({ min: 0, max: 1000 })], (n) => expect(n).toBeLessThan(10));

    expect(check).toThrow(/Counterexample: \[10\]/);
  });
});

describe("event-sourced properties", () => {
  const Opened = eventSourced.defineEvent("TabOpened", { schema: z.object({ name: z.string() }) });
  const Closed = eventSourced.defineEvent("TabClosed", { schema: z.object({}) });
  const tab = (strict: boolean) =>
    eventSourced.defineAggregate({
      name: "tab",
      initialState: (): { open: boolean; name: string } => ({ open: false, name: "" }),
      events: [Opened, Closed],
      evolve: {
        TabOpened: (_state, { name }) => ({ open: true, name }),
        // A strict evolve "rejects" an impossible order — and crashes on a history it did not expect.
        TabClosed: (state) => (strict && !state.open ? eventSourced.panic("closed before opened") : { ...state, open: false }),
      },
    });

  it("generates histories of the aggregate's own events only", () => {
    const histories = sample(anyHistory(tab(false)));

    expect(histories.flat().every((event) => ["TabOpened", "TabClosed"].includes(event.type))).toBe(true);
  });

  it("passes for an evolve that handles any order", () => {
    expect(() => everyHistoryFolds(tab(false))).not.toThrow();
  });

  it("catches an evolve that crashes on a history it did not expect", () => {
    expect(() => everyHistoryFolds(tab(true))).toThrow(/closed before opened/);
  });
});

describe("state-based properties", () => {
  const Tab = stateBased.defineAggregate({ name: "tab", schema: z.object({ name: z.string().min(1), open: z.boolean() }) });

  it("includes the aggregate not existing, unless asked for existing states", () => {
    expect(sample(anyState(Tab))).toContain(undefined);
    expect(sample(anyState(Tab, { existing: true }))).not.toContain(undefined);
  });

  it("passes for an aggregate whose valid states survive storage", () => {
    expect(() => everyStateRoundTrips(Tab)).not.toThrow();
  });
});
