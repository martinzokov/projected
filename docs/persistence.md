# Persistence

A projected service stores four kinds of data. Each is a port in `@projected/application`, each
has an in-memory and a PostgreSQL adapter, and each has a conformance suite in
`@projected/testing` that any new adapter must pass. Aggregates are stored by the project's
flavour: an `EventStore` when event-sourced, a `StateStore` (with an outbox) when state-based;
both come from the flavour's entry points (`@projected/<package>/event-sourced` or
`/state-based`). The other three ports are shared.

| Port | Holds | Conformance suite | Memory | PostgreSQL |
|---|---|---|---|---|
| `EventStore` (event-sourced) | events: per-aggregate streams plus a global log | `eventStoreConformance` | `inMemoryEventStore` | `postgresEventStore` |
| `StateStore` (state-based) | each aggregate's current state, plus an outbox of the events its saves emit | `stateStoreConformance` | `inMemoryStateStore` | `postgresStateStore` |
| `CheckpointStore` | how far each event handler has read | `checkpointStoreConformance` | `inMemoryCheckpointStore` | `postgresCheckpointStore` |
| `IdempotencyStore` | outcomes of commands sent with an idempotency key | `idempotencyStoreConformance` | `inMemoryIdempotencyStore` | `postgresIdempotencyStore` |
| `DocumentStore` | JSON documents for read models | `documentStoreConformance` | `inMemoryDocumentStore` | `postgresDocumentStore` |

Use cases never see an adapter. They depend on the ports (or on their own ports, such as
`StudentDirectory`, implemented by an adapter that uses a `DocumentStore`), and the composition
root picks the technology:

```ts
import { fromPool, migrate, postgresStores } from "@projected/store-postgres/event-sourced"; // or /state-based

const db = fromPool(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
await migrate(db);                                     // idempotent; safe from several processes
const { eventStore, checkpoints, idempotency, documents } = postgresStores(db); // stateStore when state-based
```

The stores do not have to share a technology: events in KurrentDB, idempotency in Redis and read
models in Mongo is a valid composition. A state store's states and outbox must share one,
though: they are written in one transaction.

## What each port demands

### EventStore

- Streams named `<category>-<id>`; `readStream` returns events in order and the stream version
  (number of events, 0 when absent).
- `appendToStream(stream, events, { expectedVersion })` succeeds only if the stream is at
  `expectedVersion` (or it is `"any"`), atomically for all events. Of concurrent appends at the
  same version exactly one wins; the others get `ConcurrencyConflict`.
- `readAll({ after, limit })` returns events in strictly increasing `globalPosition`, and **a
  reader that has seen position N must never later find an event below N**. This is the hard
  one: it is what lets event handlers keep a single-number checkpoint.
- Stored data is never mutated, and never shares references with the caller.

### StateStore

- Aggregates are keyed `<category>-<id>`. `load(key)` returns the version (number of saves, 0
  when never saved) and the serialized state with its schema version, or no state when the
  aggregate was never saved or was removed.
- `save(key, { state, events }, { expectedVersion })` succeeds only if the aggregate is at
  `expectedVersion` (or it is `"any"`), and then — **atomically** — replaces the state (or
  removes it, for `state: null`), bumps the version by one and appends `events` to the outbox.
  Of concurrent saves at the same version exactly one wins; the others get `ConcurrencyConflict`
  and write nothing.
- A removed aggregate keeps its version, so a writer that loaded it before the removal still
  conflicts, and saving it again continues the count.
- Outbox events carry the aggregate's key as `stream` and a per-aggregate, 1-based
  `streamVersion` that keeps counting across saves.
- `readAll({ after, limit })` returns outbox events in strictly increasing `globalPosition`, and
  **a reader that has seen position N must never later find an event below N**. This is the hard
  one: it is what lets event handlers and relays keep a single-number checkpoint.
- Stored data never shares references with the caller.

The outbox is what makes events trustworthy without event sourcing: an event exists if and only
if the state change it announces was committed. Relays (`eventRelay`) and projections read it
with checkpoints, so nothing is published for a change that rolled back, and nothing is lost when
a broker is down. Outbox rows are kept; pruning those every handler is past is an operational task.

### CheckpointStore

`load(name)` returns the last saved position (0 if none); `save(name, position)` overwrites it.
Positions can exceed 2³².

### IdempotencyStore

`claim(key, fingerprint, { lockMs, ttlMs })` is **atomic**: among concurrent claims of a free
key exactly one gets `claimed`. Others see `in-progress` (with the fingerprint) or, once
`complete(key, result)` has run, `completed` with the stored result. `release(key)` frees an
in-progress claim. A claim may be taken over after `lockMs`; a completed key is forgotten after
`ttlMs`. Use the store's own clock for both.

### DocumentStore

`collection(name, schema)` returns `get`/`put`/`delete`/`find`. `find(filter)` matches documents
whose top-level fields **equal** the filter's values (including `null` and booleans; arrays and
objects compare as whole values). Results are ordered by id, or by one field (numbers
numerically) with ties broken by id. Documents are validated against the schema when read; a
mismatch is a `DependencyFailure`, not a crash.

## How the PostgreSQL adapter meets them

- **Streams** (event-sourced) are a table `streams(stream, version)`. An append inserts the row
  if missing, then `SELECT … FOR UPDATE`s it, so concurrent appends to one stream serialize on
  the row and the version check is exact even for `"any"`.
- **States** (state-based) are a table `states(key, version, event_count, schema_version, data)`; a removed
  aggregate keeps its row with `data` null. A save inserts the row if missing, then
  `SELECT … FOR UPDATE`s it, so concurrent saves of one aggregate serialize on the row and the
  version check is exact even for `"any"`. State, version and outbox rows are written in one
  transaction.
- **Global order** (the events table, or the outbox). `bigserial` values are allocated at
  insert but become visible at commit, so without care a reader can see position 11 commit
  before 10 and skip 10 forever. Every write that records events takes a transaction-scoped
  advisory lock immediately before inserting them, so positions become visible in allocation
  order. The test suite includes a concurrent writer/reader test per flavour that fails reliably
  without the lock. The lock serializes the insert-and-commit step only (state-based saves that
  emit no events never take it); throughput stays in the thousands of writes per second. A
  future refinement can track in-flight transactions (`pg_snapshot_xmin`) instead, if one schema
  ever needs more.
- **Idempotency** is one `INSERT … ON CONFLICT … DO UPDATE … WHERE expired`, so a claim is atomic
  across any number of processes, with `now()` from the database.
- **Documents** live in one JSONB table with a GIN index. `find` uses containment (`@>`) to hit
  the index and an exact per-field equality to keep equality semantics for arrays and objects.
- **Schema** defaults to `projected` (configurable). Migrations come in tracks — `core`
  (checkpoints, idempotency, documents), `event-sourced` (streams, events) and `state-based`
  (states, outbox) — recorded per track in `<schema>.migrations` and applied under an advisory
  lock. A flavour's `migrate` applies `core` plus its own track, so the two flavours never
  collide on a version number, even in one schema.
- **Errors**: any driver failure becomes `DependencyUnavailable` naming the cause; a missing
  table adds "run migrate()" to the message.
- **Queries are typed, not strings.** The adapter is built on [Kysely](https://kysely.dev): the
  tables are declared once (`ProjectedDatabase`), and every query names tables and columns the
  compiler checks against them, with every value a bound parameter. Kysely's `sql` template — still
  parameterised — covers what a query builder cannot say: advisory locks and JSONB operators.
  Migrations use Kysely's schema builder. `fromPool` connects through node-postgres; `fromDialect`
  takes any other Kysely dialect (a serverless driver, PGlite).

## Adding a store

1. Create `@projected/store-<technology>`, depending on `@projected/application` and the driver.
2. Implement the ports the technology is good at — not necessarily all four.
3. Run the matching conformance suites from the adapter's tests, against a real server, each test
   on a fresh database, schema or key prefix.
4. Map every driver failure to `DependencyUnavailable` (or `DependencyFailure` for data that does
   not decode), and concurrency failures to `ConcurrencyConflict`. Nothing may throw.
5. Document how each guarantee above is met; the global-order guarantee needs an argument, not
   just a passing test.

### Notes for the likely next stores

| Store | Good fit for | How the hard guarantees map |
|---|---|---|
| **KurrentDB** (EventStoreDB) | `EventStore` (event-sourced only), `CheckpointStore` | Native streams and expected-revision appends (`NO_STREAM`/`ANY`/exact; projected's version N is revision N−1). The `$all` stream gives global order with commit-ordered positions — use the commit position as `globalPosition`. Checkpoints can live in a metadata stream, or use persistent subscriptions instead of `catchUp`. |
| **MongoDB** | all four (both flavours) | Events in one collection with a unique `(stream, streamVersion)` index; the stream version check in a transaction or via the unique index. Global order needs a sequencer: a counter document incremented in the append transaction, which serializes appends like the Postgres lock. Idempotency claims via `findOneAndUpdate` with `upsert` and an expiry filter; TTL indexes purge expired keys. Documents map directly (`find` with equality filters). For a `StateStore`: one document per aggregate with a `version` field; a save is `updateOne({ _id, version: expected }, …)` (or an insert for version 0) in a transaction that also inserts the outbox documents, sequenced like events. |
| **Redis** | `IdempotencyStore`, `CheckpointStore`, `DocumentStore` | Claims with `SET key value NX PX lockMs` (or a Lua script for take-over); completion as a hash with `PEXPIRE ttlMs`. Checkpoints as plain keys. Documents as hashes/JSON with secondary sets for the fields you filter on. Redis Streams can back an `EventStore`, but per-stream optimistic concurrency needs a Lua script; prefer a database for events. |
| **Convex** | `DocumentStore`, read models; `EventStore` or `StateStore` via mutations | Convex mutations are serializable transactions, so an append (or a save with its outbox rows) is one mutation that checks the version and inserts events with a counter document for the global position. Queries are reactive, which suits read models. The adapter calls Convex functions from the composition root; the functions themselves are generated per deployment. |
