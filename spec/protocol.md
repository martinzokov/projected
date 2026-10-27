# The projected protocol, version 1

**Status:** draft. **Applies to:** every projected implementation, in any language.

This document is normative. The key words MUST, MUST NOT, SHOULD and MAY are used as in
RFC 2119. The machine-readable shapes are in [`wire.schema.json`](wire.schema.json) (JSON
Schema 2020-12). The TypeScript implementation lives in [`../typescript`](../typescript).

The protocol follows the approach in Sollecito's
[*It's time to put REST to rest*](https://sollecitom.github.io/software-product-development-blog/posts/2023/2023-09-22-put-rest-to-rest/):
an API is a set of named, versioned **business operations**, not resources manipulated with
generic verbs. HTTP status codes describe the HTTP exchange, never business outcomes.

---

## 1. Operations

An **operation** is a command or a query.

- A **command** asks the service to change something: `enlist-student`, `report-student-lastname-change`.
- A **query** asks the service a question: `enlisted-students-on-joining-date`.

Every operation has:

| Field | Rule |
|---|---|
| `kind` | `command` or `query` |
| `type` | kebab-case, `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`. Names the business intent, not a data change: `enlist-student`, never `create-student` or `post-student`. |
| `version` | positive integer |
| input schema | JSON Schema of the request data |
| output schema | JSON Schema of the success value |
| errors | the business errors the operation may return, each with a name and a data schema |

### 1.1 Immutability

An operation is identified by `(kind, type, version)`. Once published, an operation's input
schema, output schema and declared errors MUST NOT change. To evolve an operation, publish
`version + 1` alongside it and mark the old version deprecated. A version MAY be removed once no
client uses it; removal is a breaking change.

Documentation (summaries, descriptions, examples) MAY change at any time.

Implementations SHOULD enforce this with a lock file of per-operation fingerprints checked in CI
(TypeScript: `projected contracts`).

### 1.2 Schemas

Schemas MUST be expressible in JSON Schema 2020-12. Values are JSON: dates are ISO-8601 strings
(`format: date` / `date-time`), not native date types.

---

## 2. Outcomes

Running an operation has exactly one outcome.

| Outcome | Meaning | Who handles it |
|---|---|---|
| **ok** | The operation succeeded. Carries a value matching the output schema. | caller's business logic |
| **business error** | The operation ran and refused, for a reason its contract declares. | caller's business logic |
| **protocol failure** | The request never reached a business outcome: unknown operation, invalid input, infrastructure failure, defect. | caller's infrastructure (retry, alert, fix the bug) |

The first two together form an **operation result**:

```json
{ "status": "ok", "value": { "studentId": "s-1" } }
```

```json
{
  "status": "error",
  "error": {
    "type": "StudentAlreadyEnlisted",
    "message": "Student s-1 is already enlisted",
    "data": { "studentId": "s-1" }
  }
}
```

- `error.type` is the error's name, PascalCase, unique within a service. It MUST be one of the
  errors the operation declares.
- `error.data` MUST match that error's data schema. It MAY be `{}`.
- `error.message` is for humans. Clients MUST NOT parse it.

A "not found" answer to a query is usually an **ok** outcome — `{ "student": null }` — because
the question had an answer. Declare a business error only when the caller should act on it.

### 2.1 Protocol failures

| Failure | Meaning | Retry? |
|---|---|---|
| `unknown-operation` | No operation with that kind, type and version | no |
| `invalid-input` | The data does not match the input schema | no |
| `concurrency-conflict` | The command raced another change to the same data | yes |
| `dependency-unavailable` | Something the service needs is unreachable | yes, with backoff |
| `dependency-failure` | Something the service needs answered unusably | no |
| `internal-error` | A defect in the service | no |

A service MUST NOT return a business error its contract does not declare: an implementation
that encounters one treats it as `internal-error` (a defect).

---

## 3. HTTP binding

### 3.1 Routes

| Method and path | Body | Purpose |
|---|---|---|
| `POST /commands/{type}/version/{version}` | the input | run one command |
| `POST /queries/{type}/version/{version}` | the input | run one query |
| `POST /commands` | `{ "commands": [item, ...] }` | run a batch of commands |
| `POST /queries` | `{ "queries": [item, ...] }` | run a batch of queries |
| `GET /openapi.json` | — | OpenAPI 3.1 document derived from the contracts |
| `GET /health` | — | `{ "status": "ok" }` |

A service MAY mount all routes under a base path (`/api/commands/...`). Queries use `POST`
because their input is a body, like a command's.

Request bodies MUST be `application/json`. An empty body MUST be treated as `{}`.

### 3.2 Status codes

| Situation | Status | Body |
|---|---|---|
| ok or business error | **200** | operation result |
| batch accepted (any item outcomes) | **200** | batch result |
| body is not JSON / not a valid batch | 400 | problem `malformed-request` |
| input does not match the schema | 400 | problem `invalid-input`, with `issues` |
| no such path | 404 | problem `not-found` |
| no such operation or version | 404 | problem `unknown-operation` |
| wrong method | 405 | problem `method-not-allowed`, with `Allow` |
| batch too large | 413 | problem `payload-too-large` |
| body is not JSON media type | 415 | problem `unsupported-media-type` |
| concurrency conflict | 409 | problem `concurrency-conflict` |
| dependency failure | 502 | problem `dependency-failure` |
| dependency unavailable | 503 | problem `dependency-unavailable`, with `Retry-After` |
| defect | 500 | problem `internal-error` — MUST NOT reveal internals |

Protocol failures use RFC 9457 problem details (`application/problem+json`) with `type` set to
`urn:projected:problem:<name>`:

```json
{
  "type": "urn:projected:problem:invalid-input",
  "title": "Invalid input",
  "status": 400,
  "detail": "Invalid input for command enlist-student@2",
  "issues": [{ "path": ["joiningDate"], "message": "Invalid ISO date", "code": "invalid_format" }]
}
```

### 3.3 Batches

```json
{
  "commands": [
    { "type": "enlist-student", "version": 1, "data": { "firstname": "Bruce", "lastname": "Wayne", "joiningDate": "2023-09-22" } },
    { "type": "report-student-lastname-change", "version": 1, "data": { "studentId": "s-1", "newLastname": "Kent" } }
  ]
}
```

Items MUST run in order and independently: one item's outcome does not stop the next, and a
batch is **not** atomic. The response has one result per item, in order. An item that does not
reach a business outcome is `{ "status": "failed", "problem": <problem details> }`.

### 3.4 Headers

| Header | Direction | Meaning |
|---|---|---|
| `X-Message-Id` | request, response | Unique id of this request. Generated by the server when absent. |
| `X-Correlation-Id` | request, response | Shared by every message in one business flow. Defaults to the message id. |
| `X-Causation-Id` | request | Id of the message that caused this one. |
| `Idempotency-Key` | request (commands) | Caller-chosen key identifying a command across retries. Passed to the handler. |

Batch items get the message id `<message id>/<index>` and share the batch's correlation id.

---

## 4. Messaging binding

Any broker that offers at-least-once delivery can carry projected messages. Bodies are JSON.

### 4.1 Commands

A queued command is the HTTP batch item plus routing metadata:

```json
{
  "kind": "command",
  "type": "enlist-student",
  "version": 2,
  "data": { "studentId": "s-1", "firstname": "Bruce", "lastname": "Wayne", "joiningDate": "2023-09-22" },
  "metadata": { "messageId": "m-1", "correlationId": "flow-1", "causationId": "web-7" }
}
```

A consumer MUST dispatch it exactly as an HTTP request, then:

| Outcome | Disposition |
|---|---|
| ok or business error | acknowledge |
| `concurrency-conflict`, `dependency-unavailable`, `dependency-failure` | redeliver later |
| `unknown-operation`, `invalid-input`, `internal-error`, unparseable body | dead-letter |

The message id SHOULD be used as the idempotency key.

### 4.2 Events

Services publish recorded events as they are stored:

```json
{
  "eventId": "e-1",
  "stream": "student-s-1",
  "streamVersion": 1,
  "globalPosition": 42,
  "type": "StudentEnlisted",
  "schemaVersion": 1,
  "data": { "studentId": "s-1", "firstname": "Bruce", "lastname": "Wayne", "joiningDate": "2023-09-22" },
  "metadata": { "correlationId": "flow-1", "causationId": "m-1" },
  "recordedAt": "2023-09-22T09:00:00.000Z"
}
```

Events SHOULD be published by reading the event store from a checkpoint (the store is the
outbox), so an event is never stored without eventually being published. Consumers MUST
tolerate duplicates.

---

## 5. Event storage

Implementations MAY use any store that provides, for the `EventStore` port:

1. **Streams** named `<category>-<id>`, where the category is camelCase and contains no dash.
2. **Append with optimistic concurrency:** append succeeds only if the stream's current version
   (its number of events; 0 when absent) equals the expected version, or the expected version is
   `any`. Of two concurrent appends at the same expected version, exactly one succeeds.
3. **Per-stream order** with 1-based `streamVersion`.
4. **A global log** readable after a position, in a strictly increasing `globalPosition` order.
5. **Immutability:** stored events never change.

Each event is stored with `type` (PascalCase, past tense), `schemaVersion` and `data`. Readers
upgrade older schema versions with migrations on read, never by rewriting the store.

The TypeScript conformance suite (`eventStoreConformance` in `@projected/testing`) is the
executable form of this section.

---

## 6. Architecture

A projected service has three layers, and dependencies point inward only:

| Layer | Contains | May depend on |
|---|---|---|
| domain | aggregates, events, decisions, business errors | itself and the language's pure projected kernel — nothing else |
| application | contracts (driving ports), driven ports, handlers (use cases), event handlers | domain, itself, the pure kernels |
| infrastructure | adapters, composition root | everything |

The domain MUST be deterministic and free of I/O. These rules MUST be enforced by the compiler or
a build-failing check in each implementation, not by convention. The TypeScript implementation
documents how in [`../docs/enforcement.md`](../docs/enforcement.md); anti-slop's
`hexagonal-architecture-enforcement` skill gives validated starting points for Python, Go,
Java/Kotlin, C# and Rust.
