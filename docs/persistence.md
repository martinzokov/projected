# Persistence

A projected service stores four kinds of data. Each is a port in `@projected/application`, each
has an in-memory and a PostgreSQL adapter, and each has a conformance suite in
`@projected/testing` that any new adapter must pass.

| Port | Holds | Conformance suite | Memory | PostgreSQL |
|---|---|---|---|---|
| `EventStore` | events: per-aggregate streams plus a global log | `eventStoreConformance` | `inMemoryEventStore` | `postgresEventStore` |
| `CheckpointStore` | how far each event handler has read | `checkpointStoreConformance` | `inMemoryCheckpointStore` | `postgresCheckpointStore` |
| `IdempotencyStore` | outcomes of commands sent with an idempotency key | `idempotencyStoreConformance` | `inMemoryIdempotencyStore` | `postgresIdempotencyStore` |
| `DocumentStore` | JSON documents for read models | `documentStoreConformance` | `inMemoryDocumentStore` | `postgresDocumentStore` |

Use cases never see an adapter. They depend on the ports (or on their own ports, such as
`StudentDirectory`, implemented by an adapter that uses a `DocumentStore`), and the composition
root picks the technology:

```ts
const sql = fromPool(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
await migrate(sql);                                    // idempotent; safe from several processes
const { eventStore, checkpoints, idempotency, documents } = postgresStores(sql);
```

The stores do not have to share a technology: events in KurrentDB, idempotency in Redis and read
models in Mongo is a valid composition.

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

- **Streams** are a table `streams(stream, version)`. An append inserts the row if missing, then
  `SELECT … FOR UPDATE`s it, so concurrent appends to one stream serialize on the row and the
  version check is exact even for `"any"`.
- **Global order.** `bigserial` values are allocated at insert but become visible at commit, so
  without care a reader can see position 11 commit before 10 and skip 10 forever. Each append
  takes a transaction-scoped advisory lock immediately before inserting its events, so positions
  become visible in allocation order. The test suite includes a concurrent writer/reader test
  that fails reliably without the lock. The lock serializes the insert-and-commit step only;
  throughput stays in the thousands of appends per second. A future refinement can track
  in-flight transactions (`pg_snapshot_xmin`) instead, if one schema ever needs more.
- **Idempotency** is one `INSERT … ON CONFLICT … DO UPDATE … WHERE expired`, so a claim is atomic
  across any number of processes, with `now()` from the database.
- **Documents** live in one JSONB table with a GIN index. `find` uses containment (`@>`) to hit
  the index and an exact per-field equality to keep equality semantics for arrays and objects.
- **Schema** defaults to `projected` (configurable), versioned in `<schema>.migrations`, applied
  under an advisory lock.
- **Errors**: any driver failure becomes `DependencyUnavailable` naming the cause; a missing
  table adds "run migrate()" to the message.
- The adapter talks to a two-method `SqlClient` (`query`, `transaction`). `fromPool` adapts
  node-postgres; a serverless driver or PGlite takes a few lines.

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
| **KurrentDB** (EventStoreDB) | `EventStore`, `CheckpointStore` | Native streams and expected-revision appends (`NO_STREAM`/`ANY`/exact; projected's version N is revision N−1). The `$all` stream gives global order with commit-ordered positions — use the commit position as `globalPosition`. Checkpoints can live in a metadata stream, or use persistent subscriptions instead of `catchUp`. |
| **MongoDB** | all four | Events in one collection with a unique `(stream, streamVersion)` index; the stream version check in a transaction or via the unique index. Global order needs a sequencer: a counter document incremented in the append transaction, which serializes appends like the Postgres lock. Idempotency claims via `findOneAndUpdate` with `upsert` and an expiry filter; TTL indexes purge expired keys. Documents map directly (`find` with equality filters). |
| **Redis** | `IdempotencyStore`, `CheckpointStore`, `DocumentStore` | Claims with `SET key value NX PX lockMs` (or a Lua script for take-over); completion as a hash with `PEXPIRE ttlMs`. Checkpoints as plain keys. Documents as hashes/JSON with secondary sets for the fields you filter on. Redis Streams can back an `EventStore`, but per-stream optimistic concurrency needs a Lua script; prefer a database for events. |
| **Convex** | `DocumentStore`, read models; `EventStore` via mutations | Convex mutations are serializable transactions, so an append is one mutation that checks the stream's version and inserts events with a counter document for the global position. Queries are reactive, which suits read models. The adapter calls Convex functions from the composition root; the functions themselves are generated per deployment. |

The state-based branch of projected (`state-based`) adds a fifth port, `StateStore`, for services
that store current state instead of events.
