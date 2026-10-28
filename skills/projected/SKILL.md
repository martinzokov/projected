---
name: projected
description: "Use whenever you build, change or review a feature in a projected app (a CQRS service, event-sourced or state-based, whose src/ has domain/, application/ and infrastructure/ and depends on @projected/*). The golden path from business requirement to served, documented endpoint — and the rules the compiler and `projected check` will hold you to."
category: software-development
---

# Building features with projected

You write **business logic only**: events, decisions, contracts and handlers. HTTP endpoints,
OpenAPI, message consumers, serialization, validation and persistence are derived from what you
write. If you find yourself writing a route, a controller, a JSON parser, a SQL query, a retry
loop, an auth check on a token or a tracing span for a feature, stop — you are in the wrong layer
or reinventing the framework.

**Check the project's flavour first** — `"flavour"` in `projected.json`, fixed for the life of
the project:

| `flavour` | Aggregates | A decision returns | Import from |
|---|---|---|---|
| `event-sourced` | folded from their events | the events that follow | `@projected/<package>/event-sourced` |
| `state-based` | stored as their current state | the next state, optionally with events | `@projected/<package>/state-based` |

Each flavour entry point (`@projected/domain/…`, `@projected/application/…`,
`@projected/store-memory/…`, `@projected/store-postgres/…`, `@projected/testing/…`) re-exports
everything shared, so each layer needs one import. The other flavour's entry points are rejected
by `projected check`.

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
| `src/domain` | itself, `@projected/domain` (and its flavour entry point) | tsc (no DOM/Node libs, project references), dependency-cruiser, ESLint |
| `src/application` | domain, itself, `@projected/application` (and its flavour entry point) | same |
| `src/infrastructure` | everything | — |
| nothing in `src` | `src/infrastructure/config` (tests may, to build the real app) | dependency-cruiser |
| `src` and `test` | only the project's own flavour | dependency-cruiser |

## The golden path

Start with the generator, which writes the files of steps 1–5 as stubs, with their tests and the
wiring — then make the stubs say what the business says:

```sh
projected new command withdraw-student --aggregate student --event StudentWithdrawn
```

It refuses names the rules would reject (a CRUD verb, an event that already exists) and writes
nothing when it does. The generated decision records the event unconditionally, the contract
takes only the id and returns `{}`, and the tests assert exactly that: steps 1–5 below are where
each changes. `projected new` also makes aggregates, queries, ports and event handlers (see
Commands).

For a requirement like *"a student who leaves the school is withdrawn, but their record is kept"*:

1. **Domain** — what happened, and what rule decides it (`projected-domain-modelling` skill):
   ```ts
   // src/domain/student/events.ts
   export const StudentWithdrawn = defineEvent("StudentWithdrawn", {
     schema: z.object({ studentId: z.string(), leavingDate: z.iso.date() }),
   });
   // src/domain/student/student.ts — event-sourced: add StudentWithdrawn to `events` and `evolve`, then:
   export function withdraw(state: StudentState, input: { studentId: string; leavingDate: string })
     : Decision<typeof Student, StudentNotEnlisted> {
     if (state.status === "unknown") return Result.err(new StudentNotEnlisted({ studentId: input.studentId }));
     if (state.status === "withdrawn") return Result.ok([]);          // already done: no-op
     return Result.ok([StudentWithdrawn(input)]);
   }
   // state-based: (state: StudentState | undefined, input) → Result.ok(noChange()) when already
   // withdrawn, else Result.ok(changeTo({ ...state, status: "withdrawn" }, StudentWithdrawn(input)))
   ```
2. **Contract** — the business operation clients call (`projected-contracts` skill):
   ```ts
   // src/application/port/driving/withdraw-student.ts
   export const WithdrawStudent = defineCommand({
     type: "withdraw-student",
     summary: "Record that a student leaves the school",
     access: { permissions: ["students:manage"] },      // omit to inherit the service default
     input: z.object({ studentId: z.string(), leavingDate: z.iso.date() }),
     output: z.object({ withdrawn: z.boolean() }),
     errors: [StudentNotEnlisted],
   });
   ```
   Add it to `defineContracts({ name, access, commands: [...] })` in `port/driving/index.ts`.
3. **Handler** — load, decide, write; the repository does concurrency and retries (and, when
   state-based, writes the emitted events to the outbox in the same transaction):
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
5. **Test** it (`projected-testing` skill): a given/when/then test per decision rule, a property
   for any rule that holds whatever the input, and an HTTP test for the endpoint. After domain
   work, `projected mutate` shows which behaviour no test checks yet.
6. **Regenerate and lock**: `projected openapi`, `projected contracts --update` and
   `projected docs`. Commit `openapi.json`, `contracts.lock.json` and `docs/catalog.md`.
7. **Verify**: run the project's check (`pnpm check` / `projected check`) and the tests. Done
   only when both are green.

`POST /commands/withdraw-student/version/1` now exists: validated, restricted to callers with
`students:manage`, protected against duplicate retries (`Idempotency-Key`), traced, documented in
OpenAPI, and callable in a batch or from Kafka/NATS — none of which you wrote.

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
| use the other flavour's API | you can't: the flavour is fixed when the project is created. Model it in your flavour |
| call `fetch`, a database, a queue | declare a port in `application/port/driven`, implement it in `infrastructure/adapter/driven/<name>`, inject it |
| use `Date.now()` / `new Date()` | inject `Clock` into the handler; pass the time into the decision |
| use `Math.random()` / `crypto.randomUUID()` | inject `IdGenerator` |
| `throw` for a business rule | `return Result.err(new SomeError(...))` with an error from `defineError` |
| `throw` for an impossible state | `panic("why this cannot happen", cause)` — it is a defect |
| `try/catch` around a port | ports return `Result`; compose with `Result.gen` / `yield*` |
| `await` an SDK or `fetch` in a driven adapter | wrap it: `fromDependency("name", () => sdk.call())` returns a Result |
| return `Promise<T>` from a driven port | return `Promise<Result<T, DependencyUnavailable \| DependencyFailure>>` |
| `await` in the domain | do async work in the handler and pass results into the decision |
| return an error the contract does not list | add it to the contract's `errors` (a new version if published), or map it |
| call another service | depend on its contracts through `RemoteService` (`projected-integrations` skill) |
| call a third-party API | `projected vendor add` for its OpenAPI spec, then a port and adapter (`projected-integrations`) |
| hand-write a vendor's request/response types | don't: generate them with `projected vendor` |
| restrict who may call an operation | set `access` on the contract (`"public"`, `"authenticated"`, `{ permissions }`) |
| know who is calling | read `context.metadata.principal` in the handler; never parse tokens or cookies |
| stop a retried command running twice | nothing: the dispatcher handles `Idempotency-Key` and message ids; make the decision idempotent too |
| store a read model | a `DocumentStore` collection behind your own port (`projected-integrations`) |
| add a span or log a trace id | nothing: operations, aggregates and event handlers are already traced |

A few **design rules** — business operation names, past-tense events, one aggregate per command —
can be set to `"warn"` or `"off"` under `"rules"` in `projected.json`, and a handler that must
write several aggregates can be listed under `allow`. That is a team decision: do not change
those settings to get your own change through; fix the name or the boundary instead.

**Never** "fix" a failing check by loosening it: do not add `lib`/`types`/`references` to a
layer's `tsconfig.json`, do not add `eslint-disable` or `@ts-ignore` (they are ignored and
reported), do not edit `contracts.lock.json` entries or `openapi.json` by hand. `projected check`
runs its own copy of the rules, so local config edits do not make it pass anyway.

## Commands

| Command | Does |
|---|---|
| `projected new service <dir> --flavour <f> --aggregate <name>` | a new service with its first aggregate; the flavour is fixed from then on |
| `projected new aggregate <name>` | an aggregate and the property test its flavour requires |
| `projected new command <type> --aggregate <name> --event <Event>` | contract, use case, stub decision, event, tests and wiring |
| `projected new query <type> --aggregate <name>` / `--port <Port>` | contract, use case, HTTP test and wiring |
| `projected new port <Name> --operations <a,b> [--adapter <factory>]` | a driven port returning Results and its adapter (on the document store by default) |
| `projected new event-handler <name> --on <Event,...> [--port <Port>]` | an event handler, registered in the composition root |
| `projected check` | architecture + design rules + contract lock + OpenAPI and vendor freshness, as CI runs it |
| `projected check --strict` | the same, also failing on design-rule warnings |
| `projected arch` | layout, layer tsconfigs, import boundaries, code rules |
| `projected openapi` | regenerate `openapi.json` from the contracts |
| `projected docs` | regenerate `docs/catalog.md`: operations, aggregates, events, handlers, ports and a Mermaid flow diagram — read it to learn a service before changing it |
| `projected contracts --update` | lock new operations (refuses changes to published ones) |
| `projected vendor add <name> --spec <url\|file>` | generate a typed, Result-returning client for a third-party OpenAPI |
| `projected vendor update <name>` | take a vendor's new spec (refuses breaking changes unless accepted) |
| `projected mutate` | mutation-test the domain and use cases; lists the changes no test notices, fails below the threshold |
| `tsc -b` | compile every layer; boundary violations are compile errors |

Related skills: `projected-domain-modelling`, `projected-contracts`, `projected-integrations`,
`projected-testing`, and the vendored `hexagonal-architecture-enforcement` and
`properties-of-good-tests`.
