# Roadmap

Built so far, in TypeScript: the kernel, CQRS contracts, the dispatcher, two flavours chosen per
project (event-sourced, and state-based with a transactional outbox), PostgreSQL persistence for
both, HTTP and messaging adapters, Kafka and NATS JetStream transports, better-auth
authentication, duplicate command protection, OpenTelemetry tracing and metrics, OpenAPI,
enforcement with configurable design rules, typed clients for third-party APIs, a living service
catalog, property-based and mutation testing, scaffolding, health, graceful shutdown and operator
tasks, snapshots, outbox pruning, structured logs, Hono hosting with CORS, JWT authentication,
guardrails and evals for coding agents, black-box conformance suites, and skills. Next
steps, roughly in order of value:

## Persistence

- **More stores**, each passing the conformance suites ([`persistence.md`](persistence.md) has
  notes per store): KurrentDB (events, checkpoints), MongoDB (all ports), Redis (idempotency,
  checkpoints, documents), Convex (documents, events via mutations).
- **Higher append throughput** on Postgres by tracking in-flight transactions instead of the
  ordering lock. The ledger's load test meets the lock first: about 420 appends a second per
  schema where a database round trip takes a millisecond, eight per transfer.

## Delivery

- **More transports**: Amazon SQS/SNS, RabbitMQ, Redis Streams, Google Pub/Sub, and a
  PostgreSQL-backed queue for zero extra infrastructure ([`messaging.md`](messaging.md)).
- **Retry with backoff** in `httpService` for queries and keyed commands.
- **Outbox fan-out at scale**: partitioned relays for very high event volumes.

## Platform

- **More auth providers** where tokens are not JWTs or claims need more than a mapping;
  `@projected/auth-jwt` covers OpenID Connect and OAuth issuers.
- **Typed client generation for other languages** from `openapi.json`.
- Publishing packages to npm; `npx skills add martinzokov/projected` for the skills.

## Enforcement

- **Contract compatibility classes**: allow provably compatible changes to published versions.
- **Composition root size check**.

## Other languages

Ports in order of fit: **Kotlin** (sealed results, Gradle modules per layer), **Rust** (crate per
layer), **Go**, **Python**, **C#**. Each needs the kernel, contracts with typed handler binding,
the dispatcher with access and idempotency, the HTTP and messaging bindings of
`spec/protocol.md`, stores and transports passing ports of the conformance suites, enforcement at
the strongest tier the language allows, and the school example — which passes when
`projected conformance --url … --suite protocol --suite school` does: the scenarios in
[`spec/conformance`](../spec/conformance) are HTTP in, HTTP out, so the TypeScript runner judges
a Kotlin school as it judges the TypeScript ones.
