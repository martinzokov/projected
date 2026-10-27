# Roadmap

What exists is a complete vertical slice in TypeScript: kernel, CQRS contracts, dispatcher,
event sourcing with an in-memory store, HTTP and messaging adapters, OpenAPI, enforcement and
skills. These are the next steps, roughly in order of value.

## Persistence

- **PostgreSQL event store** (`@projected/event-store-postgres`): streams table with a unique
  `(stream, stream_version)` constraint for optimistic concurrency, a `bigserial` global
  position, checkpoints table. Must pass `eventStoreConformance`. PGlite makes the conformance
  suite runnable without Docker.
- **Read-model storage helpers**: a document-store port with Postgres and in-memory adapters, so
  simple projections need no hand-written adapter.
- **Snapshots** for long-lived aggregates, behind the repository (no API change).

## Delivery guarantees

- **Idempotency store**: deduplicate commands by `Idempotency-Key` / message id and replay the
  stored `OperationResult`. The header is already part of the protocol and reaches handlers.
- **Broker transports** for `MessageTransport`: SQS, Kafka, NATS, RabbitMQ.
- **Retry with backoff** in `httpService` for queries and idempotent commands.

## Platform

- **Authentication and authorization**: a principal in `Metadata`, populated by transport
  middleware, with per-contract policies.
- **Observability**: OpenTelemetry spans around dispatch, handlers and ports; `traceparent`
  propagation alongside correlation ids.
- **Scaffolding**: `projected new service|aggregate|command|query` generating the files in the
  right layers (the skills describe the same steps for agents).
- **Typed client generation for other languages** from `openapi.json`.
- Publish packages to npm; `npx skills add martinzokov/projected` for the skills.

## Enforcement

- **Contract compatibility classes**: today any change to a published version fails. A future
  mode could allow provably compatible changes (documentation is already exempt).
- **ESLint rule for aggregate boundaries**: one aggregate per command handler, unless declared.
- **Composition root size check** — the one smell anti-slop notes no linter catches.

## Other languages

Ports in order of fit: **Kotlin** (sealed results, Gradle modules per layer — even more
compile-time enforcement), **Rust** (crate per layer), **Go**, **Python**, **C#**. Each needs: the
kernel, contracts with typed handler binding, the dispatcher, the HTTP binding of
`spec/protocol.md`, an event store passing a port of the conformance suite, enforcement at the
strongest tier the language allows (anti-slop has validated starting configs), and the school
example. A language-neutral **HTTP conformance suite**, run against each example service, would
make "passes the spec" mechanical.
