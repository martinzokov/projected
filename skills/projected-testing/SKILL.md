---
name: projected-testing
description: "Use when writing or reviewing tests in a projected app: decision rules (given/when/then), use cases with in-memory adapters, HTTP endpoints through the real handler, event handlers, and EventStore adapters (conformance suite). Builds on the vendored properties-of-good-tests skill."
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

## Decisions: given / when / then

```ts
import { given } from "@projected/testing";

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

`thenEvents(...)` asserts the exact events in order. One rule per test, named as the rule. The
history is events — never construct state by hand, or the test stops checking `evolve`.

## Use cases: the real composition, in memory

Build the app with the real composition root and test doubles for the outside world:

```ts
import { inMemoryCheckpointStore, inMemoryDocumentStore, inMemoryEventStore, inMemoryIdempotencyStore } from "@projected/store-memory";
import { fixedClock, principal, sequentialIds } from "@projected/testing";

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

Prefer testing them through the app (command → query). In isolation: create an
`inMemoryEventStore`, append encoded events (`Student.encode(StudentEnlisted({...}))`), and run
`catchUp(handler, store, inMemoryCheckpointStore())`. Run it twice to prove idempotency.

## Adapters

Every store and transport passes the conformance suites for the ports it implements, against a
real server — `eventStoreConformance`, `checkpointStoreConformance`, `idempotencyStoreConformance`,
`documentStoreConformance`, `messageTransportConformance`:

```ts
import { documentStoreConformance, eventStoreConformance } from "@projected/testing";
eventStoreConformance("postgres", async () => postgresEventStore(sql, { schema: await freshSchema() }));
documentStoreConformance("postgres", async () => postgresDocumentStore(sql, { schema: await freshSchema() }));
```

Gate real-server tests on an environment variable (`describe.skip` when unset) so `pnpm test`
runs anywhere, and run them with `docker compose up -d --wait && pnpm test:integration`. Write the
same kind of contract test for your own driven ports, and run it against both the in-memory fake
and the real adapter — that is what keeps the fake honest.

## Architecture is tested too

Keep a test that runs `checkArchitecture(root)` from `@projected/architecture` and expects no
violations, so `pnpm test` alone catches a boundary breach.
