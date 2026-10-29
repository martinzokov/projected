---
name: projected-integrations
description: "Use when a projected app has to reach anything outside its own aggregates: a read model or projection, another projected service (sync or async), a third-party HTTP API, a message broker, or a reaction to events (policies, notifications). Covers driven ports and adapters, RemoteService, CommandQueue, event handlers and the composition root."
category: software-development
---

# Integrations: ports, adapters and events

The application never knows *how* it talks to the world. It declares what it needs as a
**port** (an interface in `src/application/port/driven`), and an **adapter** in
`src/infrastructure/adapter/driven/<name>/` implements it. The composition root
(`src/infrastructure/config`) picks the adapter. Every asynchronous port method returns
`Promise<Result<…>>` — failures are values, never exceptions — and `projected check` enforces it
on both sides (see "Results at the boundary" below).

| Need | Port | Adapter |
|---|---|---|
| store aggregates, checkpoints, idempotency | your flavour's `EventStore` or `StateStore`, `CheckpointStore`, `IdempotencyStore` (framework) | `@projected/store-postgres`, `@projected/store-memory` |
| store read models | your own (`StudentDirectory`) over a `DocumentStore` | your adapter in `adapter/driven/<name>` |
| current time / ids | `Clock`, `IdGenerator` (framework) | `@projected/runtime`, `@projected/testing` |
| tracing | `Telemetry` (framework) | `@projected/opentelemetry` |
| who is calling | `Authenticator` (framework, used by transports) | `@projected/auth-better-auth` (sessions), `@projected/auth-jwt` (tokens from an OIDC/OAuth issuer) |
| another projected service | `RemoteService<typeof theirContracts>` (framework) | `httpService`, `inProcessService` |
| send a command asynchronously | `CommandQueue<typeof contracts>` (framework) | `commandQueue` from `@projected/messaging` |
| a third-party HTTP API | your own, e.g. `PaymentGateway` | your adapter using `httpClient` from `@projected/http` |
| an SDK that throws (email, storage, a vendor client) | your own, e.g. `Mailer` | your adapter calling the SDK inside `fromDependency` |

## A port of your own

Name it for what the application needs, never for what implements it (`StudentDirectory`, not
`PostgresStudentTable`). `projected new port StudentDirectory --operations put,joinedOn` writes
the port and an adapter on the document store as stubs; `--port StudentDirectory` on
`projected new query` or `projected new event-handler` wires that adapter into the composition
root. What the hand-written version looks like:

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

## Read models on a DocumentStore

Implement your read-model port with a `DocumentStore` collection. The same adapter then runs in
memory in tests and on Postgres (or a future Mongo/Redis store) in production:

```ts
// src/infrastructure/adapter/driven/directory/document-student-directory.ts
const Entry = z.object({ studentId: z.string(), firstname: z.string(), lastname: z.string(), joiningDate: z.iso.date() });

export function documentStudentDirectory(documents: DocumentStore): StudentDirectory {
  const entries = documents.collection("student-directory", Entry);   // validated on every read
  return {
    put: (entry) => entries.put(entry.studentId, entry),
    remove: (studentId) => entries.delete(studentId),
    joinedOn: (date) => entries.find({ joiningDate: date }, { orderBy: "lastname" }),
    // ...
  };
}
```

`find` matches top-level fields by equality and orders by one field. Anything richer (full-text,
aggregation) is a dedicated port with its own adapter.

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
after each successful command (read-your-writes). Name the ones that need it —
`inline: ["student-directory"]` — when others should stay off the request path: a relay to a
broker, a policy that calls a slow API. Always run `startPolling(app)` from `@projected/runtime`
in `main.ts` as well: it runs every handler in the background, including whatever an inline
catch-up could not finish. Delivery is at-least-once from a checkpoint: **handlers must be
idempotent** (upsert, not insert). Renaming a handler resets its checkpoint and replays
history — sometimes exactly what you want.

One failing handler never holds back the others. A handler that returns an infrastructure error
resumes at that event on the next catch-up (inline failures reach `onEventHandlingError`); one
that throws, or meets an event it cannot decode, is a defect — reported to `onDefect`, and
stuck at that event until the code is fixed. Return Results; never throw.

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
runs `consumeCommands(app, transport, { topic })`, which dispatches exactly like HTTP — same
access rules and idempotency (the message id is the key, so redeliveries never run twice):
business outcomes are acknowledged, infrastructure errors redelivered, unknown/invalid/refused
commands and defects dead-lettered to `<topic>.dead-letter`. Events go out with
`eventRelay(transport, { name, topic })` registered as an event handler — it reads the aggregate
store's log (the event store itself, or the state store's outbox), so nothing is lost between
"stored" and "published".

Pick the transport in the composition root: `natsTransport({ servers })` (NATS JetStream, the
lightweight default), `kafkaTransport({ brokers })`, or `inMemoryTransport()` when every producer
and consumer runs in one process — tests included (`delivery: "queued"` and `drain()` to step
through). In-memory, subscribe consumers before relays start, and keep relays and policies out
of `eventHandling.inline` (`docs/messaging.md` has why). The
sender's principal travels with each command; pass `principal: servicePrincipal` to
`consumeCommands` when the topic is not yours alone.

## A third-party HTTP API

When the vendor publishes an OpenAPI spec, let `projected vendor` write the client — never write
request/response types for it by hand:

```sh
projected vendor add weather --spec https://api.weather.example/openapi.yaml
```

It pins the spec (`vendor/weather.openapi.json`), generates zod schemas and a Result-returning
client (`adapter/driven/weather/weather-client.ts`, never edited by hand), and starts a port and
an adapter for you to fill in. You write the port in the application's words and the mapping in
the adapter; `vendor update` refuses breaking spec changes until you accept them. The whole
workflow is in `docs/vendors.md`.

```ts
export const weatherAdapter = (client: WeatherClient): Weather => ({
  forecastFor: async ({ lat, lon }) =>
    (await client.getForecast({ latitude: lat, longitude: lon })).map(({ body }) =>
      body.daily.map((day) => ({ date: day.date, maxTempC: day.maxTempC })),
    ),
});
```

Without a spec, wrap the API by hand in a driven adapter so the application never sees HTTP:

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
`HttpStatusError` so the adapter can translate them into business outcomes. `HttpStatusError`
is only in the type when you list `expectedErrors`, so a plain call maps straight into a port's
`DependencyUnavailable | DependencyFailure`.

## Results at the boundary

A driven adapter is where outside failures become values. Two rules hold you to it:

- `projected/driven-ports-return-results`: an asynchronous method of a port in
  `application/port/driven` returns `Promise<Result<T, DependencyUnavailable | DependencyFailure>>`
  (plus any business error the port reports) — never a bare `Promise<T>`.
- `projected/driven-adapters-return-results` (type-checked): code in `adapter/driven` awaits only
  Results. Anything that can reject — an SDK, a driver, raw `fetch` — goes through
  `fromDependency` from `@projected/application`:

```ts
// src/infrastructure/adapter/driven/email/ses-mailer.ts
export const sesMailer = (ses: SESClient): Mailer => ({
  send: async (message) =>
    (await fromDependency("email", () => ses.send(new SendEmailCommand(toSes(message))))).map(() => undefined),
});
```

`fromDependency` reads network errors, timeouts, aborts and 408/429/5xx statuses as
`DependencyUnavailable` (retryable: 503, or redelivery for queued commands) and anything else as
`DependencyFailure` (502). Pass `{ classify: (cause) => "unavailable" | "failure" }` when the SDK
signals it differently. `Result.tryPromise` is accepted too, when you need your own error.

## Who is calling, and tracing

- The principal is in `context.metadata.principal` (`id`, `permissions`, `claims`). Use it for
  business rules ("only the student's tutor"); coarse rules belong in the contract's `access`.
  Never read tokens, cookies or headers in a use case.
- Pass `context` to every port call and remote call: correlation, causation, the principal and
  the trace all flow from it, and events record `principalId` and the trace automatically.
- Tracing needs no code in use cases. Give `telemetry` to `createApplication`, to
  `aggregateRepository(..., { telemetry })`, `commandQueue` and `httpService`/`httpClient` in the
  composition root.

## The composition root

`src/infrastructure/config` is the only place that knows every layer. Keep it to wiring —
create adapters, build repositories, call `createApplication`, start servers. No logic: nothing
lints its size, so review it.

Give `createApplication({ readiness })` a check for every dependency the service cannot serve
without — `postgresReadiness(db)`, `transportReadiness("kafka", transport)` — so
`GET /health/ready` tells the truth, and end `main.ts` with `monitorBacklog` (event handler lag)
and `shutdownGracefully` (drain, then stop). See `docs/operations.md`.

Log through the `Logger` the composition root creates (`jsonLogger`), never `console`: a message
and fields — `log.warn("payment declined", { orderId, error })` — so the logs stay searchable and
carry the trace. Use cases and domain code do not log; they return Results, and the composition
root logs what matters.

HTTP is served through Hono in `web.ts`: security headers, CORS for the origins in
`CORS_ORIGINS`, a body limit. Edge concerns of your own (rate limiting, IP rules) are Hono
middleware there, before the handler; anything an operation's rules depend on — who may call it,
duplicate protection — belongs in the contract and the dispatcher, never in middleware.

Tables are listed once, in `src/infrastructure/config/migrations.ts`: `postgresMigrator(db)` for
projected's, `betterAuthMigrator(...)` for better-auth's. An adapter of yours that needs tables
of its own adds a `schemaMigrator(db, { name, tracks })` there, with forward-only migrations on
a track named after it; never write `CREATE TABLE` in an adapter. The service applies the list
at start (`prepareSchema`), and `projected migrate` applies it before a rollout.
