---
name: projected-domain-modelling
description: "Use when writing or changing anything in src/domain of a projected app: events, business errors, aggregates, state and decision functions, or when an event's or a stored state's schema has to change. Covers both flavours (event-sourced and state-based), determinism, aggregate boundaries, idempotent decisions, and expected failures vs defects."
category: software-development
---

# Domain modelling in projected

The domain is a set of **pure, synchronous functions** over immutable data. It imports
`@projected/domain/<flavour>` and nothing else — the compiler has no DOM or Node library there,
so `fetch`, `console`, timers and `node:*` do not even type-check.

**First, find the project's flavour:** `"flavour"` in `projected.json`. It decides how aggregates
are stored and what a decision returns, and it never changes. Then read the matching reference
for aggregates and decisions:

| `flavour` | Aggregates are | A decision returns | Read |
|---|---|---|---|
| `event-sourced` | folded from their events (`initialState` + `evolve`) | the events that follow | [`references/event-sourced.md`](references/event-sourced.md) |
| `state-based` | stored as their current state (a zod `schema`) | the next state (`changeTo`/`remove`/`noChange`), optionally with events | [`references/state-based.md`](references/state-based.md) |

Import from your flavour's entry point (`@projected/domain/event-sourced` or
`@projected/domain/state-based`); it re-exports everything shared, which also lives in
`@projected/domain` itself. `projected check` rejects the other flavour's entry point. Everything
below applies to both.

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

Published events never change: they are stored (event-sourced) or consumed by other services
(both flavours). Bump the version and say how to read the old one:

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

## Aggregates and decisions: what both flavours share

- An aggregate is the unit of consistency: one command changes one aggregate. If a rule spans
  several, either the boundary is wrong or the rule is eventually consistent (a policy).
- Its name is camelCase with no dashes (`student`); it is stored under `<name>-<id>`.
- Keep only the state decisions need. Read models are for queries (`projected-integrations`).
- Decisions are plain functions next to the aggregate:
  `(state, input) => Decision<typeof Student, Errors>`.
- **Pure and deterministic.** Everything a decision needs arrives as arguments: the time
  (`reportedAt`), generated ids, facts loaded from other places. The repository may run a decision
  more than once on a concurrency conflict.
- **Defects are not outcomes.** If a state is impossible (an invariant broke), call
  `panic("why", cause)`. Never `throw`; never return a defect as a business error.
- Prefer idempotent decisions — "already done" is an accepted no-op, not an error: retries and
  redelivered messages are normal in this architecture.

## Checklist

- [ ] Imports only from `@projected/domain/<the project's flavour>`
- [ ] Events are past tense, carry decision-time facts and ids, JSON schemas only
- [ ] Decisions take time/ids as input; no `Date`, `Math.random`, `async`, `throw`, `try`
- [ ] Every rejection is a `defineError` class with a schema and a clear message
- [ ] The flavour reference's checklist is done too
- [ ] A given/when/then test per rule (`projected-testing`)
