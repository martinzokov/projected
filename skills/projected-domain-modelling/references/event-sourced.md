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

### Long streams: snapshots

An aggregate whose streams grow into the thousands of events (an account with years of entries)
opts into snapshots; nothing else changes. The repository stores its state every `every` events
and loads from the latest snapshot plus the events after it:

```ts
const AccountState = z.object({ status: z.enum(["none", "open", "closed"]), balance: z.number().int() });

export const Account = defineAggregate({
  name: "account",
  initialState: (): z.infer<typeof AccountState> => ({ status: "none", balance: 0 }),
  events: [AccountOpened, MoneyDeposited],
  evolve: {
    AccountOpened: (state) => ({ ...state, status: "open" }),
    MoneyDeposited: (state, { amount }) => ({ ...state, balance: state.balance + amount }),
  },
  snapshot: { schema: AccountState, version: 1, every: 100 },   // JSON schemas only
});
```

- **Bump `version` whenever `evolve` or the state changes.** Snapshots under another version are
  ignored, so the state is folded from the events again; a stale snapshot never leaks through.
- Snapshots are a cache: one that is missing, unreadable or invalid only costs a full fold.
  Don't add them to short-lived aggregates — a student with a dozen events gains nothing.
- The composition root passes the store: `aggregateRepository(Account, eventStore, { snapshots })`.

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
- [ ] A snapshot policy only for aggregates with long streams, its `version` bumped with `evolve`
- [ ] `initialState` has an annotated return type
- [ ] Decisions return `Result.ok([events])`, `Result.ok([])` or `Result.err(error)`
