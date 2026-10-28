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
| Broker | Apache Kafka 3.5–4.2 | NATS server with JetStream | none: one process |
| Client | `@platformatic/kafka` (pure TypeScript) | `@nats-io/jetstream` | — |
| Topic | Kafka topic | subject `<prefix>.<topic>` in one stream | name |
| Consumer group | Kafka consumer group | durable pull consumer | group name |
| Order | per key (partition) | per subscription (`maxInFlight: 1`) | per group: one message at a time |
| Retry | in place, with backoff, before the next message | `nak` with delay | in place, with backoff, before the next message |
| Dead letters | `<topic>.dead-letter` | `<topic>.dead-letter` | `<topic>.dead-letter`, and `onDeadLetter` |
| Durable | yes | yes | for the life of the process; see below |
| Publish dedup | no (consumer idempotency covers it) | yes, by message id | no |

All three pass `messageTransportConformance` (`@projected/testing/messaging`): the brokers
against real servers, the in-memory transport in each of its delivery modes.

### Choosing

- **NATS JetStream** is the lightweight option: one ~20 MB binary, no JVM or ZooKeeper,
  persistent streams, native per-message ack, delayed redelivery and termination. Pick it for
  most services and small teams.
- **Kafka** when you already run it, need very high throughput, long retention or a large
  ecosystem of consumers reading the same log.
- **In-memory** when every producer and consumer runs in one process — a modular monolith, a
  development setup, tests — with no broker to run. It can run in production: see below for
  what it guarantees.

```ts
const transport = process.env.KAFKA_BROKERS
  ? kafkaTransport({ brokers: process.env.KAFKA_BROKERS.split(","), clientId: "school" })
  : process.env.NATS_URL
    ? natsTransport({ servers: process.env.NATS_URL })
    : inMemoryTransport();
```

## In-memory: one process, no broker

`inMemoryTransport()` gives `consumeCommands`, `consumeEvents` and `eventRelay` a broker's
behaviour within one process, so the same code runs with or without Kafka or NATS. `delivery`
says when `publish` returns:

| `delivery` | `publish` returns | Delivery | A crash loses |
|---|---|---|---|
| `"acknowledged"` (default) | once every consumer group subscribed to the topic has handled the message | at once | nothing a relay or policy published |
| `"async"` | as soon as the message is queued | at once | what was queued and not yet handled |
| `"queued"` | at once | only when you call `drain()` | — (tests) |

Everything before the transport is already durable — events are in the event store or the
outbox, and a relay reads them from a checkpoint. With a broker, the relay moves its checkpoint
once the broker has a message. With `"acknowledged"`, it moves only once the consumers have
handled it, so a message lost in a crash is published again by the relay after the restart:
at-least-once, as with a broker, and consumers already ignore duplicates. A policy that queues a
command is a checkpointed event handler too, and gets the same guarantee. `"async"` trades that
for speed and accepts the loss.

```ts
const bus = inMemoryTransport({ onDeadLetter: (message, reason) => console.warn("dead letter", message.id, reason) });
const school = composeSchool({ ...stores, eventHandlers: [eventRelay(bus, { name: "school-events", topic: "school.events" })] });
// Consumers first: an acknowledged publish waits for the groups subscribed when it is sent.
await consumeCommands(school, bus, { topic: "school.commands", principal: admissionsService });
await consumeEvents(attendanceRegister, bus, { topic: "school.events" });
startPolling(school); // relays run in the background, never inline
```

Both school examples have this as a test (`test/together.test.ts`): admissions queues an
enlistment, the school runs it and relays its events, and attendance keeps a register — three
services, one process, no broker.

What to know:

- **Planned restarts lose nothing in any mode:** `close()` delivers what is waiting before it
  stops; `shutdownGracefully` calls it last, through the environment's `close`.
- **Subscribe consumers before relays start.** A message published to a topic no group has
  subscribed to yet is only kept in memory, for groups that subscribe later (the latest `retain`
  per topic, 10 000 by default).
- **A group with no subscriber** cannot acknowledge: the message is kept for it, and `publish`
  returns `DependencyUnavailable` at once, so the relay keeps its checkpoint and tries again.
- **An acknowledged publish waits at most `ackTimeoutMs`** (30 s), then fails the same way; the
  consumer may still handle the message, so it may arrive twice.
- **Keep publishing handlers out of `eventHandling.inline`** when the service consumes what they
  publish: the command a consumer runs would wait for the very catch-up that is waiting for the
  consumer. The timeout turns that into a delay and a duplicate rather than a hang.
- **Dead letters live in memory.** `onDeadLetter` hands each one over to log or store;
  `replay-dead-letters` replays them for the life of the process.
- **One process only.** For services in separate processes, use NATS or Kafka.

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

Implement `MessageTransport` (`publish`, `subscribe(topic, handler, { group })`, `ping`, `close`)
and run `messageTransportConformance` (from `@projected/testing/messaging`) against a real
broker; `withTimeout` and `sleep` from `@projected/messaging` cover a prompt `ping()` and retry
backoff. Candidates: Amazon SQS/SNS (visibility
timeout as retry, redrive policy as dead letters), RabbitMQ (quorum queues, `nack` with requeue,
dead-letter exchanges), Redis Streams (consumer groups, `XACK`, `XCLAIM` for redelivery), Google
Pub/Sub, and a PostgreSQL-backed queue (`SELECT … FOR UPDATE SKIP LOCKED`) for zero extra
infrastructure.
