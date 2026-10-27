---
name: projected
description: "Use whenever you build, change or review a feature in a projected app (an event-sourced, CQRS service whose src/ has domain/, application/ and infrastructure/ and depends on @projected/*). The golden path from business requirement to served, documented endpoint — and the rules the compiler and `projected check` will hold you to."
category: software-development
---

# Building features with projected

You write **business logic only**: events, decisions, contracts and handlers. HTTP endpoints,
OpenAPI, message consumers, serialization, validation and persistence are derived from what you
write. If you find yourself writing a route, a controller, a JSON parser or a SQL query for a
feature, stop — you are in the wrong layer or reinventing the framework.

## Where everything goes

```
src/
├── domain/<aggregate>/            pure: no I/O, no async, no clock, no randomness
│   ├── events.ts                  defineEvent — facts, past tense: StudentEnlisted
│   ├── errors.ts                  defineError — broken business rules: StudentAlreadyEnlisted
│   └── <aggregate>.ts             defineAggregate + decision functions
├── application/
│   ├── port/driving/              defineCommand / defineQuery, and index.ts with defineContracts
│   ├── port/driven/               interfaces for what the app needs (read models, gateways)
│   └── usecase/                   handlers (CommandHandler / QueryHandler), event handlers
└── infrastructure/
    ├── adapter/driven/<name>/     implementations of your driven ports
    └── config/                    composition root: createApplication(...) binds everything
test/                              given/when/then, use-case and HTTP tests
```

| Layer | May import | Enforced by |
|---|---|---|
| `src/domain` | itself, `@projected/domain` | tsc (no DOM/Node libs, project references), dependency-cruiser, ESLint |
| `src/application` | domain, itself, `@projected/application` | same |
| `src/infrastructure` | everything | — |
| nothing | `src/infrastructure/config` | dependency-cruiser |

## The golden path

For a requirement like *"a student who leaves the school is withdrawn, but their record is kept"*:

1. **Domain** — what happened, and what rule decides it (`projected-domain-modelling` skill):
   ```ts
   // src/domain/student/events.ts
   export const StudentWithdrawn = defineEvent("StudentWithdrawn", {
     schema: z.object({ studentId: z.string(), leavingDate: z.iso.date() }),
   });
   // src/domain/student/student.ts — add StudentWithdrawn to `events` and `evolve`, then:
   export function withdraw(state: StudentState, input: { studentId: string; leavingDate: string })
     : Decision<typeof Student, StudentNotEnlisted> {
     if (state.status === "unknown") return Result.err(new StudentNotEnlisted({ studentId: input.studentId }));
     if (state.status === "withdrawn") return Result.ok([]);          // already done: no-op
     return Result.ok([StudentWithdrawn(input)]);
   }
   ```
2. **Contract** — the business operation clients call (`projected-contracts` skill):
   ```ts
   // src/application/port/driving/withdraw-student.ts
   export const WithdrawStudent = defineCommand({
     type: "withdraw-student",
     summary: "Record that a student leaves the school",
     input: z.object({ studentId: z.string(), leavingDate: z.iso.date() }),
     output: z.object({ withdrawn: z.boolean() }),
     errors: [StudentNotEnlisted],
   });
   ```
   Add it to `defineContracts({ commands: [...] })` in `port/driving/index.ts`.
3. **Handler** — load, decide, append; the repository does concurrency and retries:
   ```ts
   // src/application/usecase/withdraw-student.ts
   export const withdrawStudent =
     (deps: { students: AggregateRepository<typeof Student> }): CommandHandler<typeof WithdrawStudent> =>
     async (input, context) =>
       (await deps.students.execute(input.studentId, (state) => withdraw(state, input), context))
         .map(({ events }) => ({ withdrawn: events.length > 0 }));
   ```
4. **Bind** it in the composition root — `createApplication` will not compile until you do:
   ```ts
   commands: { ..., "withdraw-student@1": withdrawStudent({ students }) },
   ```
5. **Test** it (`projected-testing` skill): a given/when/then test per decision rule, and an
   HTTP test for the endpoint.
6. **Regenerate and lock**: `projected openapi` and `projected contracts --update`. Commit
   `openapi.json` and `contracts.lock.json`.
7. **Verify**: run the project's check (`pnpm check` / `projected check`) and the tests. Done
   only when both are green.

`POST /commands/withdraw-student/version/1` now exists, validated, documented in OpenAPI, and
callable in a batch or from a message queue — none of which you wrote.

## Naming: business operations, not data operations

Commands and queries are named for what the business does, never for a data change.

| ✗ Data-shaped | ✓ Business-shaped |
|---|---|
| `create-student` | `enlist-student` |
| `update-student` / `patch-student` | `report-student-lastname-change` |
| `delete-student` | `withdraw-student` |
| `get-students?date=` | `enlisted-students-on-joining-date` |
| `create-order` | `place-order` |
| `set-order-status` | `ship-order`, `cancel-order` |

If two business reasons lead to the same data change, they are two commands. Ask "what did the
user just *decide* to do?" — that is the command.

## When a check stops you

| You want to… | Do this instead |
|---|---|
| call `fetch`, a database, a queue | declare a port in `application/port/driven`, implement it in `infrastructure/adapter/driven/<name>`, inject it |
| use `Date.now()` / `new Date()` | inject `Clock` into the handler; pass the time into the decision |
| use `Math.random()` / `crypto.randomUUID()` | inject `IdGenerator` |
| `throw` for a business rule | `return Result.err(new SomeError(...))` with an error from `defineError` |
| `throw` for an impossible state | `panic("why this cannot happen", cause)` — it is a defect |
| `try/catch` around a port | ports return `Result`; compose with `Result.gen` / `yield*` |
| `await` in the domain | do async work in the handler and pass results into the decision |
| return an error the contract does not list | add it to the contract's `errors` (a new version if published), or map it |
| call another service | depend on its contracts through `RemoteService` (`projected-integrations` skill) |

**Never** "fix" a failing check by loosening it: do not add `lib`/`types`/`references` to a
layer's `tsconfig.json`, do not add `eslint-disable` or `@ts-ignore` (they are ignored and
reported), do not edit `contracts.lock.json` entries or `openapi.json` by hand. `projected check`
runs its own copy of the rules, so local config edits do not make it pass anyway.

## Commands

| Command | Does |
|---|---|
| `projected check` | architecture + contract lock + OpenAPI freshness, as CI runs it |
| `projected arch` | layout, layer tsconfigs, import boundaries, code rules |
| `projected openapi` | regenerate `openapi.json` from the contracts |
| `projected contracts --update` | lock new operations (refuses changes to published ones) |
| `tsc -b` | compile every layer; boundary violations are compile errors |

Related skills: `projected-domain-modelling`, `projected-contracts`, `projected-integrations`,
`projected-testing`, and the vendored `hexagonal-architecture-enforcement` and
`properties-of-good-tests`.
