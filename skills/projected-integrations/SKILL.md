---
name: projected-integrations
description: "Use when a projected app has to reach anything outside its own aggregates: a read model or projection, another projected service (sync or async), a third-party HTTP API, a message broker, or a reaction to events (policies, notifications). Covers driven ports and adapters, RemoteService, CommandQueue, event handlers and the composition root."
category: software-development
---

# Integrations: ports, adapters and events

The application never knows *how* it talks to the world. It declares what it needs as a
**port** (an interface in `src/application/port/driven`), and an **adapter** in
`src/infrastructure/adapter/driven/<name>/` implements it. The composition root
(`src/infrastructure/config`) picks the adapter. Every port method returns a `Result` — failures
are values, never exceptions.

| Need | Port | Adapter |
|---|---|---|
| store events | `EventStore` (framework) | `@projected/store-memory`, future database stores |
| current time / ids | `Clock`, `IdGenerator` (framework) | `@projected/runtime`, `@projected/testing` |
| a read model | your own, e.g. `StudentDirectory` | your adapter in `adapter/driven/<name>` |
| another projected service | `RemoteService<typeof theirContracts>` (framework) | `httpService`, `inProcessService` |
| send a command asynchronously | `CommandQueue<typeof contracts>` (framework) | `commandQueue` from `@projected/messaging` |
| a third-party HTTP API | your own, e.g. `PaymentGateway` | your adapter using `httpClient` from `@projected/http` |

## A port of your own

Name it for what the application needs, never for what implements it (`StudentDirectory`, not
`PostgresStudentTable`):

```ts
// src/application/port/driven/student-directory.ts
import type { DependencyUnavailable, Result } from "@projected/application";

export interface StudentDirectory {
  put(entry: DirectoryEntry): Promise<Result<void, DependencyUnavailable>>;
  joinedOn(date: string): Promise<Result<readonly DirectoryEntry[], DependencyUnavailable>>;
}
```

Return infrastructure errors (`DependencyUnavailable` when unreachable, `DependencyFailure` when
it answered unusably) or business-meaningful results — never raw driver errors.

## Projections: keeping a read model current

```ts
// src/application/usecase/student-directory-projection.ts
export const studentDirectoryProjection = (deps: { directory: StudentDirectory }) =>
  defineEventHandler({
    name: "student-directory",                 // kebab-case; also the checkpoint name
    events: [StudentEnlisted, StudentLastnameChanged, StudentWithdrawn],
    handle: {                                  // one function per event, checked at compile time
      StudentEnlisted: ({ data }) => deps.directory.put(data),
      StudentLastnameChanged: ({ data }) => deps.directory.rename(data.studentId, data.newLastname),
      StudentWithdrawn: ({ data }) => deps.directory.remove(data.studentId),
    },
  });
```

Register it in the composition root under `eventHandling`. By default handlers run **inline**
after each successful command (read-your-writes). For background processing set
`inline: false` and run `startPolling(app)` from `@projected/runtime`. Delivery is
at-least-once from a checkpoint: **handlers must be idempotent** (upsert, not insert). Renaming a
handler resets its checkpoint and replays history — sometimes exactly what you want.

## Policies: reacting to events

A policy is an event handler that calls ports instead of updating a read model — send a welcome
email, enqueue a follow-up command. Pass the handler's `context` on so correlation flows:

```ts
export const welcomePolicy = (deps: { mailer: Mailer }) =>
  defineEventHandler({
    name: "welcome-new-students",
    events: [StudentEnlisted],
    handle: {
      StudentEnlisted: async ({ data }, context) => deps.mailer.sendWelcome(data.studentId, context),
    },
  });
```

## Calling another projected service

Depend on its **contracts** (share them as a package), never on its internals:

```ts
// a handler in src/application/usecase/
export const enlistWithLibraryCard =
  (deps: { library: RemoteService<typeof libraryContracts>; students: AggregateRepository<typeof Student> }): CommandHandler<typeof EnlistStudentV2> =>
  async (input, context) =>
    Result.gen(async function* () {
      const card = yield* Result.await(deps.library.execute(IssueLibraryCard, { holder: input.studentId }, context));
      yield* Result.await(deps.students.execute(input.studentId, (s) => enlist(s, { ...input }), context));
      return Result.ok({ studentId: input.studentId });
    });
```

The remote call's result has exactly the remote handler's shape — output, its declared business
errors, or an infrastructure error — so `yield*` propagates them unchanged. Remote business errors
you do not want to expose must be mapped (your contract's `errors` are checked at compile time).

Wire it in the composition root: `httpService(libraryContracts, { baseUrl })` for a network
call, `inProcessService(libraryApp)` for a modular monolith or tests. Same port, same code.

## Asynchronous commands

```ts
await deps.queue.enqueue(SendReportCard, { studentId }, context);   // Result<{ messageId }, ...>
```

`commandQueue(contracts, transport, { topic, ids })` implements the port; the receiving service
runs `consumeCommands(app, transport, { topic })`, which dispatches exactly like HTTP: business
outcomes are acknowledged, infrastructure errors redelivered, unknown/invalid/defects
dead-lettered. Events go out with `eventRelay(transport, { name, topic })` registered as an event
handler — the event store is the outbox, so nothing is lost between "stored" and "published".

## A third-party HTTP API

Wrap it in a driven adapter so the application never sees HTTP:

```ts
// src/infrastructure/adapter/driven/payments/stripe-payment-gateway.ts
export const stripePaymentGateway = (http: HttpClient): PaymentGateway => ({
  charge: async (amount) =>
    (await http.request({ method: "POST", path: "/charges", body: amount, response: Charge, expectedErrors: [402] }))
      .map(({ body }) => ({ chargeId: body.id }))
      .tryRecover((error) => (HttpStatusError.is(error) ? Result.err(new PaymentDeclined()) : Result.err(error))),
});
// composition root: stripePaymentGateway(httpClient({ dependency: "stripe", baseUrl, headers: () => ({ authorization }) }))
```

`httpClient` turns network errors, timeouts and 5xx into `DependencyUnavailable`, unexpected
bodies into `DependencyFailure`, and statuses you list in `expectedErrors` into
`HttpStatusError` so the adapter can translate them into business outcomes.

## The composition root

`src/infrastructure/config` is the only place that knows every layer. Keep it to wiring —
create adapters, build repositories, call `createApplication`, start servers. No logic: nothing
lints its size, so review it.
