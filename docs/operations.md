# Running a service

What a projected service tells the platform it runs on, how it stops without losing work, and
how an operator maintains it while it runs.
Everything here is wired in the school examples' `main.ts` and in what `projected new service`
generates.

## Tables before the rollout

A service lists the tables it keeps in one module, `src/infrastructure/config/migrations.ts`:
projected's (`postgresMigrator`), better-auth's (`betterAuthMigrator`), and those of any adapter
of its own (`schemaMigrator`). Each is a `SchemaMigrator` from `@projected/application`, which
says what is pending and applies it. Two things use the list:

- **The service, at start.** `prepareSchema(migrators, { apply })` from `@projected/runtime`
  applies what is pending, so `pnpm start` against a new database just works. With
  `MIGRATE_ON_START=false` it only checks, and refuses to start against tables that are behind,
  naming what is pending and the command to run.
- **`projected migrate`, as a deploy step.** It loads the same module and applies each migrator
  in order, stopping at the first failure. `--check` changes nothing and exits 1 while changes
  are pending.

```sh
DATABASE_URL=… projected migrate              # the release job, before any new instance starts
MIGRATE_ON_START=false DATABASE_URL=… pnpm start  # every instance of the new version
```

In production, prefer the deploy step:

- a migration that fails stops the rollout, rather than every new instance failing to start;
- the service's database role needs no right to create or alter tables;
- better-auth migrates without a lock, so instances starting together can race on its tables.
  projected's own migrations take an advisory lock and are safe from any number of processes.

While a rollout runs, the old version keeps serving against the new tables, so a migration must
leave it working: add tables and nullable columns first, and drop what only the old version
used in a later release (expand, then contract). Migrations only go forward. A published one
is never edited; a fix is a new one.

Stored data changes shape without any of this: events and states are upgraded when read (see
the domain modelling skill), and a read model is rebuilt with `projected operate rebuild`.

## Health

| Route | Answers | Use it for |
|---|---|---|
| `GET /health/live` (and `GET /health`) | `200 { "status": "ok" }` while the process can answer | the liveness probe: restart only when this fails |
| `GET /health/ready` | the application's health report — `200` when ready, `503` otherwise | the readiness probe: send traffic only when this passes |

The report names each dependency the service cannot serve without:

```json
{ "status": "unready", "checks": [{ "name": "postgres", "status": "up" }, { "name": "kafka", "status": "down", "message": "kafka: no broker answered" }] }
```

`status` is `ready` when every check is up, `unready` when one is down, and `draining` once the
service has started to shut down. The shape is `HealthReport` in
[`spec/wire.schema.json`](../spec/wire.schema.json); the routes are in
[the protocol](../spec/protocol.md#35-health).

Readiness checks are `ReadinessCheck`s given to `createApplication({ readiness })`, built by the
adapters that know their dependency:

```ts
import { postgresReadiness } from "@projected/store-postgres/event-sourced";
import { transportReadiness } from "@projected/messaging";

const readiness = [postgresReadiness(db), transportReadiness("kafka", kafka)];
```

Each answers within a bounded time (2 s by default): a dependency that does not answer is down.
Every `MessageTransport` has a `ping()`, which the transport conformance suite holds it to. A
check of your own returns `Result<void, DependencyUnavailable | DependencyFailure>` and must not
hang — a check that throws is reported down rather than failing the probe.

## Shutting down without dropping work

`shutdownGracefully` from `@projected/runtime` runs on SIGTERM and SIGINT:

```ts
shutdownGracefully({
  app,                               // reports draining at once, and is waited on
  intake: [server, poller, backlog], // what takes in work: servers, subscriptions, pollers
  close: infrastructure.close,       // pools and broker connections, last
  graceMs: 5_000,                    // a little more than the readiness probe's interval
});
```

1. The application reports `draining`: readiness answers 503, and load balancers stop sending.
2. After `graceMs`, the intake closes — the server stops accepting connections, subscriptions
   stop receiving, pollers finish their current catch-up.
3. Operations and catch-ups still in flight finish (`app.drain()` waits for them).
4. Connections close and the process exits with 0 — or 1 when a step failed or the whole took
   longer than `timeoutMs` (30 s by default).

## Metrics

The `Telemetry` port records metrics as well as spans: `count`, `record` (a distribution) and
`gauge`. `@projected/opentelemetry` sends them to OpenTelemetry's global meter; configure an SDK
with a metric exporter to collect them. In tests, `recordingTelemetry()` keeps them, with
`counted(name, attributes)` and `gauged(name, attributes)` to assert on.

| Metric | Kind | Attributes | Recorded by |
|---|---|---|---|
| `projected.operations` | counter | `projected.service`, `projected.operation.kind`, `.type`, `.version`, `projected.outcome` (`ok`, `error`, `failed`), `projected.error.type` | the dispatcher, for every operation over any transport |
| `projected.events.handled` | counter | `projected.event_handler` | every catch-up |
| `http.server.request.duration` | distribution, seconds | `http.request.method`, `http.route`, `http.response.status_code` | the HTTP handler |
| `projected.event_handler.lag` | gauge, seconds | `projected.event_handler` | `monitorBacklog` |
| `projected.event_handler.position` | gauge | `projected.event_handler` | `monitorBacklog` |

### Event handler lag

`monitorBacklog(app, { clock })` measures, every 15 s, how long the oldest event each handler
has yet to process has been waiting — 0 when it is caught up. A lag that keeps growing is a
handler failing on an event, or one too slow for the rate of events. `app.backlog()` gives the
same as data: each handler's checkpoint and its oldest pending event.

In the state-based flavour handlers read the outbox, so an event relay's lag is how long events
wait in the outbox before they reach the broker.

## Operator tasks

Maintenance on a live service runs as an operator task: `POST /operate/{task}`, or from a shell,

```sh
export PROJECTED_OPERATOR_TOKEN=…        # a principal with projected:operate
projected operate --url https://school.internal                       # list the tasks
projected operate backlog --url https://school.internal
projected operate rebuild --url https://school.internal --input '{"handler":"student-directory"}'
```

Every task requires the `projected:operate` permission — the school examples and generated
services grant it to better-auth admins — and runs through the dispatcher's path: validated,
traced as `task <name>`, counted in `projected.operator_tasks`, waited for by a drain. Tasks are
not contracts: they are absent from the OpenAPI document and the contract lock.

| Task | Input | Does |
|---|---|---|
| `list-tasks` | `{}` | every task, its description and its input |
| `backlog` | `{}` | each event handler's checkpoint and oldest pending event — `app.backlog()` |
| `rebuild` | `{ "handler": name }` | the handler's `reset`, if it has one, then its checkpoint back to 0 and every event replayed to it |
| `replay-dead-letters` | `{ "topic": name }` | from `deadLetterReplay(transport, { topics })` in `@projected/messaging`: the topic's dead letters published back to it |

**Rebuild** replays in the process's catch-up queue, so no catch-up there moves the checkpoint
meanwhile; stop event handling on other instances first. Give a handler a `reset` when replaying
over what it built is not enough — a read model whose rows a buggy version wrote:

```ts
// clear() is an operation you add to the read model's port for it
defineEventHandler({ name: "student-directory", events: [...], handle: { ... }, reset: () => directory.clear() });
```

**Dead-letter replay** reads `<topic>.dead-letter` as its own consumer group, whose position the
broker keeps, so each dead letter is replayed once; it finishes once none has arrived for a
couple of seconds. Messages keep their ids: a dead-lettered command never completed, so its
idempotency key is free and it runs again; a dead-lettered event reaches the consumers that
failed it. Each carries a `projected-replay` header, which brokers that deduplicate by id (NATS
JetStream) honour.

```ts
createApplication(contracts, { ..., operatorTasks: [deadLetterReplay(kafka, { topics: ["billing.commands"] })] });
```

A task of your own is `defineOperatorTask({ name, description, input, run })`, given to
`createApplication({ operatorTasks })`.
