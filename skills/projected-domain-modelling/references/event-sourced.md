# Event-sourced aggregates and decisions

For projects with `"flavour": "event-sourced"`. Import from `@projected/domain/event-sourced`.
An aggregate's state is never stored: it is folded from the aggregate's events every time it is
loaded, so the events are the truth and the history is kept forever.

## Aggregates: state folded from events

```ts
import { Result, defineAggregate, type Decision } from "@projected/domain/event-sourced";

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

- **Three outcomes, three meanings:**
  | Return | Meaning |
  |---|---|
  | `Result.ok([event, ...])` | accepted; these facts are now true |
  | `Result.ok([])` | accepted, already true — idempotent no-op |
  | `Result.err(new SomeError(...))` | refused; a business rule the caller can act on |

## Checklist

- [ ] Every event in `events` has an `evolve` handler; `evolve` never rejects
- [ ] `initialState` has an annotated return type
- [ ] Decisions return `Result.ok([events])`, `Result.ok([])` or `Result.err(error)`
