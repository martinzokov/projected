# Running a service

What a projected service tells the platform it runs on, and how it stops without losing work.
Everything here is wired in the school examples' `main.ts` and in what `projected new service`
generates.

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

const readiness = [postgresReadiness(sql), transportReadiness("kafka", kafka)];
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
