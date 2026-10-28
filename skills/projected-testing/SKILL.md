---
name: projected-testing
description: "Use when writing or reviewing tests in a projected app: decision rules (given/when/then), use cases with in-memory adapters, HTTP endpoints through the real handler, event handlers, and store and transport adapters (conformance suites), in both flavours. Builds on the vendored properties-of-good-tests skill."
category: software-development
---

# Testing a projected app

Most of a projected app is pure functions and typed wiring, so most tests need no mocks, no
network and no database. Read the vendored `properties-of-good-tests` skill first; this one says
where each kind of test goes. Tests live in `test/`, never in `src/`.

| Level | What it proves | Tools | Share |
|---|---|---|---|
| decision | a business rule | `given` from `@projected/testing` | most tests |
| use case | handler + repository + ports, through the contract | `app.execute`, in-memory adapters | some |
| HTTP | the operation is served as the protocol says | `httpHandler(app)` + `Request` | a few per operation |
| adapter | a real adapter meets its port | conformance suites | per adapter |
| property | a rule holds for every valid input | `forAll`, `fromSchema` | per invariant |

## Decisions: given / when / then

`given` comes from your flavour's entry point and speaks its language: an event history when
event-sourced, a state when state-based. One rule per test, named as the rule.

**Event-sourced** (`@projected/testing/event-sourced`):

```ts
import { given } from "@projected/testing/event-sourced";

const enlisted = StudentEnlisted({ studentId: "s-1", firstname: "Bruce", lastname: "Wayne", joiningDate: "2023-09-22" });

it("refuses to enlist the same student twice", () => {
  given(Student, [enlisted])
    .when((state) => enlist(state, { studentId: "s-1", firstname: "Bruce", lastname: "Wayne", joiningDate: "2023-09-22" }))
    .thenRejectsWith(StudentAlreadyEnlisted, { studentId: "s-1" });
});

it("records nothing when the name is unchanged", () => {
  given(Student, [enlisted])
    .when((state) => reportLastnameChange(state, { studentId: "s-1", newLastname: "Wayne", reportedAt: "2023-10-01T09:00:00.000Z" }))
    .thenNothingHappens();
});
```

`thenEvents(...)` asserts the exact events in order. The history is events — never construct
state by hand, or the test stops checking `evolve`.

**State-based** (`@projected/testing/state-based`):

```ts
import { given } from "@projected/testing/state-based";

const bruce = { studentId: "s-1", firstname: "Bruce", lastname: "Wayne", joiningDate: "2023-09-22" };
const enlisted: StudentState = { firstname: "Bruce", lastname: "Wayne", joiningDate: "2023-09-22", status: "enlisted" };

it("enlists a new student", () => {
  given(Student)                                              // no such student yet
    .when((state) => enlist(state, bruce))
    .thenChangesTo(enlisted, StudentEnlisted(bruce));
});

it("refuses to enlist the same student twice", () => {
  given(Student, enlisted)
    .when((state) => enlist(state, bruce))
    .thenRejectsWith(StudentAlreadyEnlisted, { studentId: "s-1" });
});

it("changes nothing when the name is unchanged", () => {
  given(Student, enlisted)
    .when((state) => reportLastnameChange(state, { studentId: "s-1", newLastname: "Wayne", reportedAt: "2023-10-01T09:00:00.000Z" }))
    .thenNothingHappens();
});
```

`thenChangesTo(state, ...events)` asserts the exact next state and the exact events in order;
`thenRemoves(...events)` a removal. One rule per test, named as the rule. The given state and the
state a decision stores both go through the aggregate's schema, so a test cannot pass with a state
the store would refuse.

## Properties: rules that hold for every input

An example test checks one case; a property checks hundreds the computer picks, and shrinks a
failure to the smallest case that still breaks. Use them for rules that hold *whatever* the
input — they complement the examples above, they do not replace them. `forAll` fails by
throwing, so `given(...).then...` and `expect` work inside it; `fromSchema` makes values valid
for any zod schema (a contract's `input`, an event's schema), parsed by the schema itself so
refinements hold.

```ts
import { everyHistoryFolds, forAll, fromSchema, given } from "@projected/testing/event-sourced";

it("folds any history of student events, however unlikely its order", () => {
  everyHistoryFolds(Student);                       // evolve must cope with whatever is in the store
});

it("enlists anyone the contract accepts, exactly once", () => {
  forAll([fromSchema(EnlistStudentV2.input)], (input) => {
    given(Student).when((state) => enlist(state, input)).thenEvents(StudentEnlisted(input));
    given(Student, [StudentEnlisted(input)]).when((state) => enlist(state, input)).thenRejectsWith(StudentAlreadyEnlisted);
  });
});
```

State-based, `anyState(Student)` is any valid state or none (`undefined`), and
`anyState(Student, { existing: true })` always a state; `everyStateRoundTrips(Student)` checks
that every valid state survives storage unchanged:

```ts
import { anyState, everyStateRoundTrips, forAll, fromSchema, given } from "@projected/testing/state-based";

it("never changes a withdrawn student's name, whatever is reported", () => {
  forAll([anyState(Student, { existing: true }), fromSchema(Report)], (state, report) => {
    given(Student, { ...state, status: "withdrawn" })
      .when((current) => reportLastnameChange(current, report))
      .thenRejectsWith(StudentNotEnlisted);
  });
});
```

Every aggregate gets `everyHistoryFolds` or `everyStateRoundTrips`. A failure prints the seed;
pass `{ seed }` to replay it. `fc` (fast-check) is re-exported for arbitraries the helpers
don't cover.

## Use cases: the real composition, in memory

Build the app with the real composition root and test doubles for the outside world:

```ts
// event-sourced; a state-based project imports the /state-based entry points and passes
// `stateStore: inMemoryStateStore(...)` instead of `eventStore`
import { inMemoryCheckpointStore, inMemoryDocumentStore, inMemoryEventStore, inMemoryIdempotencyStore } from "@projected/store-memory/event-sourced";
import { fixedClock, principal, sequentialIds } from "@projected/testing/event-sourced";

const clock = fixedClock("2023-10-01T09:00:00.000Z");
const app = composeSchool({
  eventStore: inMemoryEventStore({ clock, ids: sequentialIds("event") }),
  checkpoints: inMemoryCheckpointStore(),
  documents: inMemoryDocumentStore(),
  idempotency: inMemoryIdempotencyStore({ clock }),
  clock,
  ids: sequentialIds("student"),
});
const registrar = principal("u-registrar", ["students:manage"]);

const outcome = await app.execute(
  EnlistStudentV1,
  { firstname: "Bruce", lastname: "Wayne", joiningDate: "2023-09-22" },
  { principal: registrar },
);
expect(outcome.unwrap()).toEqual({ studentId: "student-1" });
```

`app.execute` goes through validation, the handler, serialization and error decoding — the same
path as HTTP — and returns typed output or typed errors. Inline projections have run by the time
it returns, so a query right after a command sees its effect.

- Use `fixedClock` and `sequentialIds`: tests must be deterministic.
- Pass a `principal(id, permissions)` in the metadata; test the access rules once per operation
  (anonymous → `Unauthenticated`, missing permission → `Forbidden`), not in every test.
- Test idempotency through the app: execute twice with the same `idempotencyKey`, assert one event.
- Assert on tracing with `recordingTelemetry()` (spans, parents, attributes), never a real exporter.
- Fake a port with a plain object implementing the interface. Don't mock framework internals.
- To test failure handling, give the port a fake that returns
  `Result.err(new DependencyUnavailable({ dependency: "x", message: "down" }))`.

## HTTP: the protocol, without a server

```ts
const handler = httpHandler(app, { authenticator: tokenAuthenticator({ "registrar-token": registrar }) });
// requests then send `authorization: Bearer registrar-token`
const response = await handler(new Request("http://school.test/commands/enlist-student/version/2", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
}));
expect(response.status).toBe(200);
expect(await response.json()).toEqual({ status: "error", error: { type: "StudentAlreadyEnlisted", message: "...", data: { studentId: "s-42" } } });
```

Business errors are `200` with `status: "error"`; only protocol problems use 4xx/5xx. To test a
client of another service without a network, pass the handler as `fetch`:
`httpService(contracts, { baseUrl: "http://x", fetch: (input, init) => handler(new Request(input, init)) })`.

## Event handlers

Prefer testing them through the app (command → query). In isolation, record events in an
in-memory store and run `catchUp(handler, store, inMemoryCheckpointStore())`; run it twice to
prove idempotency:

- event-sourced: `inMemoryEventStore()`, then `appendToStream(key, [Student.encode(StudentEnlisted({...}))], { expectedVersion: 0 })`
- state-based: `inMemoryStateStore()`, then `save(key, { state: Student.encode(state), events: [Student.encodeEvent(StudentEnlisted({...}))] }, { expectedVersion: 0 })`

## Adapters

Every store and transport passes the conformance suites for the ports it implements, against a
real server — `eventStoreConformance` or `stateStoreConformance` (from the flavour entry points),
`checkpointStoreConformance`, `idempotencyStoreConformance`,
`documentStoreConformance`, and `messageTransportConformance` from `@projected/testing/messaging`:

```ts
import { documentStoreConformance, eventStoreConformance } from "@projected/testing/event-sourced";
eventStoreConformance("postgres", async () => postgresEventStore(db, { schema: await freshSchema() }));
documentStoreConformance("postgres", async () => postgresDocumentStore(db, { schema: await freshSchema() }));
```

Gate real-server tests on an environment variable (`describe.skip` when unset) so `pnpm test`
runs anywhere, and run them with `docker compose up -d --wait && pnpm test:integration`. Write the
same kind of contract test for your own driven ports, and run it against both the in-memory fake
and the real adapter — that is what keeps the fake honest.

## Mutation testing: do the tests check what the code does?

`projected mutate` (needs `@stryker-mutator/core` and `vitest` as dev dependencies) makes small
changes to the domain and the use cases — a condition flipped, a string emptied, a branch
removed — and runs the tests against each. A change no test notices is a behaviour nobody
checks; the score is the share noticed, and the run fails below `"mutation": { "threshold" }` in
projected.json (default 70; the school examples hold 90). It lists each surviving change as
`file:line Mutator → replacement`, with the full report in `reports/mutation/index.html`.

For each survivor, write the test that would have caught it, named as the behaviour — not a test
of the mutant. A survivor that changes nothing observable (an unreachable guard) is an equivalent
mutant: leave it. It is slow (one test run per mutant), so it is not part of `projected check`;
run it before finishing domain work and in CI. Tests about code shape skip themselves when
`PROJECTED_MUTATION` is set, since they would see the instrumented copy.

## Architecture is tested too

Keep a test that runs `checkArchitecture(root)` from `@projected/architecture` and expects no
violations, so `pnpm test` alone catches a boundary breach. Skip it under mutation testing —
`describe.skipIf(process.env["PROJECTED_MUTATION"] !== undefined)` — and import the checker inside
the test (`await import("@projected/architecture")`): a skipped file still loads what it imports,
once per mutant.
