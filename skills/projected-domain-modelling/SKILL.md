---
name: projected-domain-modelling
description: "Use when writing or changing anything in src/domain of a projected app: events, business errors, aggregates, state and decision functions, or when an event's schema has to change. Covers determinism, aggregate boundaries, idempotent decisions, and expected failures vs defects."
category: software-development
---

# Domain modelling in projected

The domain is a set of **pure, synchronous functions** over immutable data. It imports
`@projected/domain` and nothing else — the compiler has no DOM or Node library there, so `fetch`,
`console`, timers and `node:*` do not even type-check.

## Events: what happened

```ts
import { defineEvent, z } from "@projected/domain";

export const StudentEnlisted = defineEvent("StudentEnlisted", {
  schema: z.object({
    studentId: z.string(),
    firstname: z.string(),
    lastname: z.string(),
    joiningDate: z.iso.date(),
  }),
});

StudentEnlisted({ studentId: "s-1", firstname: "Bruce", lastname: "Wayne", joiningDate: "2023-09-22" });
// → { type: "StudentEnlisted", data: { ... } }
```

- PascalCase, **past tense**, named in the business's language: `StudentEnlisted`, not `StudentCreated`.
- Carry the facts a reader needs — including values computed at decision time (`previousLastname`,
  `reportedAt`). Events are read for years; do not make readers recompute history.
- JSON-compatible schemas only: strings for dates (`z.iso.date()`, `z.iso.datetime()`), no `z.date()`.

### Changing an event's shape

Stored events never change. Bump the version and say how to read the old one:

```ts
export const StudentEnlisted = defineEvent("StudentEnlisted", {
  version: 2,
  schema: z.object({ studentId: z.string(), firstname: z.string(), lastname: z.string(),
                     middleName: z.string().nullable(), joiningDate: z.iso.date() }),
  migrations: [
    migration(1, z.object({ studentId: z.string(), firstname: z.string(), lastname: z.string(), joiningDate: z.iso.date() }),
      (v1) => ({ ...v1, middleName: null })),
  ],
});
```

One migration per older version (`1 → 2`, `2 → 3`, ...). New events are written at the current
version; old ones are upgraded when read. Never remove an event definition that has been stored.

## Business errors: rules a request can break

```ts
import { defineError, z } from "@projected/domain";

export class StudentAlreadyEnlisted extends defineError("StudentAlreadyEnlisted", {
  schema: z.object({ studentId: z.string() }),
  message: ({ studentId }) => `Student ${studentId} is already enlisted`,
  description: "A student with this id has already been enlisted.",   // shown in OpenAPI
}) {}
```

Errors without data omit the schema and take no arguments:
`export class TermIsClosed extends defineError("TermIsClosed", { message: "The term is closed" }) {}`,
then `new TermIsClosed()`. The schema is the error's public contract: clients receive the data
and rebuild the error from it.

## Aggregates: a consistency boundary

```ts
export type StudentState =
  | { readonly status: "unknown" }
  | { readonly status: "enlisted" | "withdrawn"; readonly firstname: string; readonly lastname: string; readonly joiningDate: string };

export const Student = defineAggregate({
  name: "student",                                        // stream category: student-<id>
  initialState: (): StudentState => ({ status: "unknown" }),   // annotate the return type
  events: [StudentEnlisted, StudentLastnameChanged, StudentWithdrawn],
  evolve: {
    StudentEnlisted: (_state, { firstname, lastname, joiningDate }) => ({ status: "enlisted", firstname, lastname, joiningDate }),
    StudentLastnameChanged: (state, { newLastname }) => (state.status === "unknown" ? state : { ...state, lastname: newLastname }),
    StudentWithdrawn: (state) => (state.status === "unknown" ? state : { ...state, status: "withdrawn" }),
  },
});
```

- `evolve` must handle every listed event — a missing handler is a compile error.
- `evolve` never rejects anything: the event already happened. Decisions reject; evolve applies.
- Keep only the state decisions need. Read models are for queries (`projected-integrations`).
- An aggregate is the unit of consistency: one command changes one aggregate. If a rule spans
  several, either the boundary is wrong or the rule is eventually consistent (a policy).

## Decisions: state + request → events, or a broken rule

```ts
export function reportLastnameChange(
  state: StudentState,
  input: { studentId: string; newLastname: string; reportedAt: string },
): Decision<typeof Student, StudentNotEnlisted> {
  if (state.status !== "enlisted") return Result.err(new StudentNotEnlisted({ studentId: input.studentId }));
  if (state.lastname === input.newLastname) return Result.ok([]);                // nothing to record
  return Result.ok([StudentLastnameChanged({ ...input, previousLastname: state.lastname })]);
}
```

- **Pure and deterministic.** Everything a decision needs arrives as arguments: the time
  (`reportedAt`), generated ids, facts loaded from other places. The repository may run a decision
  more than once on a concurrency conflict.
- **Three outcomes, three meanings:**
  | Return | Meaning |
  |---|---|
  | `Result.ok([event, ...])` | accepted; these facts are now true |
  | `Result.ok([])` | accepted, already true — idempotent no-op |
  | `Result.err(new SomeError(...))` | refused; a business rule the caller can act on |
- **Defects are not outcomes.** If a state is impossible (an invariant broke), call
  `panic("why", cause)`. Never `throw`; never return a defect as a business error.
- Prefer idempotent decisions: retries and redelivered messages are normal in this architecture.

## Checklist

- [ ] Events are past tense, carry decision-time facts, JSON schemas only
- [ ] Every event in `events` has an `evolve` handler; `evolve` never rejects
- [ ] `initialState` has an annotated return type
- [ ] Decisions take time/ids as input; no `Date`, `Math.random`, `async`, `throw`, `try`
- [ ] Every rejection is a `defineError` class with a schema and a clear message
- [ ] A given/when/then test per rule (`projected-testing`)
