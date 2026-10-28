# Messaging

Asynchronous messaging in projected is two things, both built on one small transport port:

- **Queued commands** — `commandQueue(contracts, transport, { topic, ids })` implements the
  `CommandQueue` port; `consumeCommands(app, transport, { topic })` runs them through the same
  dispatcher as HTTP: same validation, access rules, idempotency and handlers.
- **Published events** — `eventRelay(transport, { name, topic })` is an event handler that
  publishes each recorded event, reading the aggregate store's log from a checkpoint — the event
  store itself, or the state store's outbox — so an event is published if and only if it was
  committed. `consumeEvents(handler, transport, { topic })` feeds another service's events
  to one of your event handlers.

The normative rules are in [`spec/protocol.md` §4](../spec/protocol.md).

## Transports

| | `@projected/kafka` | `@projected/nats` | `inMemoryTransport` |
|---|---|---|---|
| Broker | Apache Kafka 3.5–4.2 | NATS server with JetStream | none |
| Client | `@platformatic/kafka` (pure TypeScript) | `@nats-io/jetstream` | — |
| Topic | Kafka topic | subject `<prefix>.<topic>` in one stream | name |
| Consumer group | Kafka consumer group | durable pull consumer | group name |
| Order | per key (partition) | per subscription (`maxInFlight: 1`) | per group |
| Retry | in place, with backoff, before the next message | `nak` with delay | requeue |
| Dead letters | `<topic>.dead-letter` | `<topic>.dead-letter` | `<topic>.dead-letter` |
| Durable | yes | yes | no |
| Publish dedup | no (consumer idempotency covers it) | yes, by message id | no |

Both brokers pass `messageTransportConformance` against real servers.

### Choosing

- **NATS JetStream** is the lightweight option: one ~20 MB binary, no JVM or ZooKeeper,
  persistent streams, native per-message ack, delayed redelivery and termination. Pick it for
  most services and small teams.
- **Kafka** when you already run it, need very high throughput, long retention or a large
  ecosystem of consumers reading the same log.
- **In-memory** for tests and single-process development. Nothing is delivered until `drain()`.

```ts
const transport = process.env.KAFKA_BROKERS
  ? kafkaTransport({ brokers: process.env.KAFKA_BROKERS.split(","), clientId: "school" })
  : natsTransport({ servers: process.env.NATS_URL ?? "nats://localhost:4222" });
```

## Delivery semantics

At least once, everywhere. What makes that safe:

- Queued commands carry their message id as the idempotency key; with an `IdempotencyStore`
  configured, a redelivered command returns its stored outcome instead of running again.
- Event handlers must be idempotent (upsert, not insert): they re-run after a crash between
  handling and checkpointing.
- Events are keyed by stream, so on Kafka one aggregate's events stay in one partition, in order.

Dispositions map outcomes to broker actions: business outcomes are acknowledged; infrastructure
errors and `request-in-progress` are redelivered; unknown operations, invalid input, refused
access and defects are dead-lettered. A message that is still failing after `maxAttempts`
deliveries is dead-lettered too.

## Principals and traces across the broker

`commandQueue` attaches the sender's principal to each command, and `consumeCommands` runs the
command as that principal by default — right when only your own services can publish to the
topic. For a topic others can write to, pass `principal: <service principal>` so every command
runs with a fixed identity. Trace context travels in message headers, and relayed events carry
the trace they were recorded under, so one trace covers request → events → broker → consumer.

## Adding a transport

Implement `MessageTransport` (`publish`, `subscribe(topic, handler, { group })`, `close`) and run
`messageTransportConformance` against a real broker. Candidates: Amazon SQS/SNS (visibility
timeout as retry, redrive policy as dead letters), RabbitMQ (quorum queues, `nack` with requeue,
dead-letter exchanges), Redis Streams (consumer groups, `XACK`, `XCLAIM` for redelivery), Google
Pub/Sub, and a PostgreSQL-backed queue (`SELECT … FOR UPDATE SKIP LOCKED`) for zero extra
infrastructure.
