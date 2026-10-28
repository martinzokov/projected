# State-based aggregates and decisions

For projects with `"flavour": "state-based"`. Import from `@projected/domain/state-based`.
An aggregate is stored as its current state, and a decision computes the next state directly.
Decisions may also emit events, which reach projections and other services through an outbox
written in the same transaction.

## Aggregates: a consistency boundary with a stored state

```ts
import { defineAggregate, z, type StateOf } from "@projected/domain/state-based";

export const Student = defineAggregate({
  name: "student",                          // storage key: student-<id>; camelCase, no dashes
  schema: z.object({
    firstname: z.string().min(1),
    lastname: z.string().min(1),
    joiningDate: z.iso.date(),
    status: z.enum(["enlisted", "withdrawn"]),
  }),
  events: [StudentEnlisted, StudentLastnameChanged, StudentWithdrawn],  // what decisions may emit
});
export type StudentState = StateOf<typeof Student>;
```

- The schema is the stored shape: JSON-compatible only (strings for dates, `z.iso.date()`, no
  `z.date()`). It is checked when a decision's state is saved and when it is loaded.
- "Does not exist" is `undefined`, not a status. Decisions receive `StudentState | undefined`.
- `events` is optional. List only events something outside the aggregate reacts to.

### Changing the state's shape

Stored states are read back at their stored version. Bump `version` and say how to read the old
one; states are upgraded when loaded and rewritten at the current version on the next save:

```ts
export const Student = defineAggregate({
  name: "student",
  version: 2,
  schema: z.object({ firstname: z.string(), lastname: z.string(), middleName: z.string().nullable(), ... }),
  migrations: [
    migration(1, z.object({ firstname: z.string(), lastname: z.string(), ... }), (v1) => ({ ...v1, middleName: null })),
  ],
});
```

One migration per older version (`1 → 2`, `2 → 3`, ...).

## Decisions: state + request → the next state, or a broken rule

```ts
import { Result, changeTo, noChange, remove, type Decision } from "@projected/domain/state-based";

export function reportLastnameChange(
  state: StudentState | undefined,
  input: { studentId: string; newLastname: string; reportedAt: string },
): Decision<typeof Student, StudentNotEnlisted> {
  if (state?.status !== "enlisted") return Result.err(new StudentNotEnlisted({ studentId: input.studentId }));
  if (state.lastname === input.newLastname) return Result.ok(noChange());      // nothing to store
  return Result.ok(
    changeTo({ ...state, lastname: input.newLastname },                         // the next state
      StudentLastnameChanged({ ...input, previousLastname: state.lastname })),  // and what to announce
  );
}
```

- **Four outcomes, four meanings:**
  | Return | Meaning |
  |---|---|
  | `Result.ok(changeTo(state, ...events))` | accepted; store this state, announce these events |
  | `Result.ok(remove(...events))` | accepted; delete the aggregate, announce these events |
  | `Result.ok(noChange())` | accepted, already true — idempotent no-op |
  | `Result.err(new SomeError(...))` | refused; a business rule the caller can act on |
- **Build the whole next state.** `changeTo` takes the complete state, usually `{ ...state, field }`.
  The type checker holds it to the schema's type; refinements (`.min(1)`) are checked on save.
- Prefer keeping a record (`status: "withdrawn"`) to `remove()`, unless the business really
  forgets the thing (erasure requests, abandoned drafts).

## Events in a state-based project

- Events are announcements, not the storage: list in `events` only what something outside the
  aggregate reacts to, and carry the aggregate's id and every fact a reader needs — readers never
  see the state.
- A decision can only emit events listed in its aggregate's `events` (a compile error otherwise).

## Checklist

- [ ] The state schema is JSON-compatible and holds only what decisions need
- [ ] Decisions take `State | undefined` and return `changeTo` / `remove` / `noChange` or a business error
- [ ] A changed state shape bumps `version` with a migration
- [ ] Emitted events are listed in the aggregate's `events`
