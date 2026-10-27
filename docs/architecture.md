# projected — architecture and decisions

projected is a system for building event-sourced, CQRS services in which developers and AI
agents write **only domain and application logic**. Transport, persistence, serialization,
validation and API documentation are derived from that logic, and the architecture is enforced
by machines rather than by convention.

This document explains the model and records the decisions behind it. The normative,
language-neutral protocol is [`spec/protocol.md`](../spec/protocol.md); the list of enforced rules
is [`enforcement.md`](enforcement.md).

---

## 1. What you write, and what you get

```
         YOU WRITE                                    PROJECTED DERIVES
 ┌────────────────────────────┐
 │ domain                     │
 │  events     defineEvent    │ ─────────────▶  event serialization + schema migrations
 │  errors     defineError    │ ─────────────▶  typed wire errors, OpenAPI error schemas
 │  aggregate  defineAggregate│ ─────────────▶  load/decide/append with optimistic concurrency
 │  decisions  pure functions │
 ├────────────────────────────┤
 │ application                │
 │  contracts  defineCommand  │ ─────────────▶  POST /commands/{type}/version/{n}, batches,
 │             defineQuery    │                 input validation, OpenAPI 3.1, typed clients,
 │                            │                 message consumers, contract lock
 │  handlers   CommandHandler │
 │  ports      interfaces     │
 │  projections defineEvent-  │ ─────────────▶  checkpointed catch-up, inline or background
 │             Handler        │
 ├────────────────────────────┤
 │ composition root           │
 │  createApplication(...)    │ ─────────────▶  compile error if any contract has no handler
 └────────────────────────────┘
```

A feature is: events and a decision (domain), a contract and a handler (application), one line
in the composition root. See the `projected` skill for the walk-through.

---

## 2. Layers and boundaries

projected uses the hexagonal layout from anti-slop's `hexagonal-architecture-enforcement` skill
unchanged, and maps its own concepts onto it:

| Hexagonal concept | projected concept | Location | Written by |
|---|---|---|---|
| domain model | aggregates, events, decisions, business errors | `src/domain` | you |
| driving port | **contracts** (commands, queries) | `src/application/port/driving` | you |
| use case | **handlers**, projections, policies | `src/application/usecase` | you |
| driven port | framework ports (`EventStore`, `Clock`, `IdGenerator`, `RemoteService`, `CommandQueue`) and your own (`StudentDirectory`) | `@projected/application`, `src/application/port/driven` | framework / you |
| driving adapter | HTTP endpoints, message consumers | `@projected/http`, `@projected/messaging` | **framework** |
| driven adapter | event stores, HTTP clients, your adapters | `@projected/*`, `src/infrastructure/adapter/driven` | framework / you |
| composition root | `createApplication(...)` | `src/infrastructure/config` | you (wiring only) |

### How the boundaries are handled

**Inbound (driving side).** A contract *is* the driving port. The framework's adapters only ever
see contracts and a transport-neutral dispatcher (`Application.dispatch`), never handlers. Every
transport — HTTP single calls, HTTP batches, queued commands, in-process calls — goes through the
same dispatch path: look up the contract, validate input, run the handler, validate output,
classify the outcome. Transports differ only in how they map outcomes to their protocol. This is
why an app normally has *no* driving adapters of its own.

**Outbound (driven side).** Handlers receive ports through plain dependency injection: a handler
is a function of its dependencies (`(deps) => CommandHandler<typeof X>`). The composition root
creates adapters and passes them in. There is no container, no decorators and no reflection —
types are checked by the compiler, and tests pass fakes the same way.

**Between services.** A service publishes its contracts; other services depend on the contracts
only. `RemoteService<typeof theirContracts>` is a framework port whose `execute` returns
*exactly* the remote handler's signature: its output, its declared business errors, or an
infrastructure error. A use case therefore composes a remote call with `yield*` like any other
step, and whether the call goes over HTTP (`httpService`) or stays in-process
(`inProcessService`) is a composition-root decision. Asynchronous calls use the `CommandQueue`
port, whose messages are the same envelope as an HTTP batch item.

**The kernel exception.** anti-slop's rule is that the domain imports nothing outside itself. A
framework has to put its building blocks somewhere, so projected makes exactly one exception per
inner layer: the domain may import `@projected/domain` and the application may import
`@projected/application`. Both packages are themselves pure (they compile without DOM or Node
types, like the layers that use them), re-export the Result type and the schema library, and
contain no I/O. Every other package — including every framework adapter — is infrastructure-only.

---

## 3. Event sourcing model

- **Events** are `{ type, data }`, defined with a zod schema and a schema version. Older stored
  versions are upgraded on read through declared migrations; stored events never change.
- **Aggregates** follow the decider pattern, split for ergonomics: `defineAggregate` declares the
  initial state and an `evolve` handler per event (exhaustive at compile time). Decisions are
  separate pure functions `(state, input) => Result<events, BusinessError>`, so each rule can be
  named, tested and reused by several contract versions.
- **Repositories** (`aggregateRepository(aggregate, store)`) run load → fold → decide → append,
  with the loaded version as the expected version. On a conflict the cycle re-runs on fresh
  state (decisions are pure, so this is safe), up to a limit. Events carry correlation and
  causation ids from the request that caused them.
- **Streams** are `<category>-<id>`; the store keeps a global log with strictly increasing
  positions.
- **Event handlers** (projections and policies) consume the global log from a checkpoint, at
  least once. They run inline after each command (read-your-writes) or in the background. The
  event relay is just another event handler, so the event store is the outbox.

## 4. Error model

Every failure is one of three things, and each has one place where it is handled:

| Kind | Example | Represented as | Handled by |
|---|---|---|---|
| **business error** | `StudentAlreadyEnlisted` | `Result.err(new X())` from `defineError`, declared on the contract | the caller's business logic: `200` with `status: "error"` |
| **infrastructure error** | database down, remote 503, concurrency conflict | `DependencyUnavailable`, `DependencyFailure`, `ConcurrencyConflict` | the transport: 409/502/503, message redelivery |
| **defect** | thrown exception, undeclared error, output not matching the contract | `Panic` / `OperationDefect` | the framework: opaque 500, reported through `onDefect` |

All three ride on better-result: expected failures are values in the type signature, defects are
`Panic`s. A handler's return type admits only its contract's declared business errors plus
infrastructure errors, so the OpenAPI document can never under-document an operation.

## 5. The HTTP API pattern

The HTTP binding implements Sollecito's *It's time to put REST to rest*:

- `POST /commands/{type}/version/{version}` and `POST /queries/{type}/version/{version}`; the body
  is the input. Each `(type, version)` is its own API, so renaming a business concept means adding
  operations, not versioning the whole API.
- Batches for free: `POST /commands` with `{ "commands": [{ type, version, data }] }`.
- Business outcomes are `200 OK`; HTTP status codes are kept for the protocol: malformed or
  invalid requests (400), unknown operations (404), conflicts (409), dependency failures
  (502/503), defects (500). A missing student is `200 { "student": null }`, never a 404 that could
  equally mean a mistyped URL.
- Protocol failures are RFC 9457 problem details with `urn:projected:problem:*` types.

---

## 6. Decisions

**D1 — Derive at runtime and generate artifacts, rather than generating source code.**
Routes, validation and clients are derived from contract objects at runtime, with full type
inference — there is no generated TypeScript to drift from the source or to edit by mistake.
What *is* generated are reviewable artifacts: `openapi.json` (for other languages, gateways and
humans) and `contracts.lock.json` (for immutability). `projected check` fails CI when either is
stale. A source generator remains an option for languages without TypeScript's type-level
features.

**D2 — Contract immutability is enforced, not recommended.** The lock file fingerprints each
operation's input, output and declared errors (documentation excluded). A changed published
version fails CI with instructions to add a new version. This is the article's versioning model,
made mechanical.

**D3 — Three tiers of enforcement, and the strongest one first.** Following anti-slop: per-layer
TypeScript projects make boundary violations *compile errors* (tier 2) inside a single package —
the domain and application layers compile against the ECMAScript library alone, so `fetch`,
`console`, timers and `node:*` do not exist there, and project references make a domain →
application import error TS6307. dependency-cruiser (imports, npm packages, cycles) and ESLint
(determinism, exceptions, async in the domain, bypass comments) add tier-1 checks for what the
compiler cannot see. A layout check protects the layer tsconfigs themselves.

**D4 — `projected check` uses its own rule sets.** The CLI runs dependency-cruiser and ESLint
with the framework's configuration objects and ignores local config files. Editing
`eslint.config.js` or adding `eslint-disable` (ignored via `noInlineConfig`, and reported) cannot
make CI pass. Every rule has a fitness test that seeds a violation and asserts the check fails —
a check is only trusted once it has been seen to fail.

**D5 — The decider is split into `evolve` and decision functions.** One `decide(command, state)`
with a command union scales poorly in TypeScript and forces every rule into one function.
Separate decisions are pure functions with precise error types, reusable across contract
versions (`enlist-student` v1 and v2 share `enlist`).

**D6 — Business errors carry schemas (`defineError`).** better-result's `TaggedError` gives typed,
matchable errors; `defineError` adds a runtime schema so errors can be documented in OpenAPI and
rebuilt as real class instances by typed clients — including in other services.

**D7 — Libraries.** better-result for Results (generator composition, `Panic` for defects,
serializable shape matching the wire format's `status: "ok" | "error"`). zod 4 for schemas
(native JSON Schema output, Standard Schema, widely known by agents). TypeScript **6.0**, not 7:
TypeScript 7 (the native port) does not ship the JavaScript compiler API that typescript-eslint
and dependency-cruiser need. pnpm workspaces, vitest, Node ≥ 22.

**D8 — Web-standard HTTP.** The inbound adapter is a `(Request) => Promise<Response>` function,
so it runs on Node (`serve` from `@projected/http/node`), Bun, Deno and edge runtimes, and can be
tested without a socket.
No web framework dependency.

**D9 — anti-slop is vendored, not a submodule.** `vendor/anti-slop` is a copy pinned to an
upstream commit (recorded in `UPSTREAM.md`) and refreshed only by `scripts/sync-anti-slop.sh`.
Submodules are not initialised in many CI and agent environments; a copy is always present. The
dependency-cruiser rules in `@projected/architecture` derive from its validated TypeScript config.

---

## 7. Other languages

The design separates what is language-neutral from what is TypeScript-specific:

| Language-neutral (shared) | Per language |
|---|---|
| `spec/protocol.md`, `spec/wire.schema.json` | kernel: Result, schemas, `defineEvent`/`defineError`/`defineAggregate` equivalents |
| the layer model and its rules | contracts and typed handler binding |
| OpenAPI documents (clients in any language) | dispatcher, HTTP and messaging adapters |
| skills: modelling, naming, versioning, testing | enforcement with the strongest local tier |

A port is complete when an example service in the new language passes the same HTTP-level
behaviour as `typescript/examples/school` and its architecture checks fail on seeded violations.
anti-slop's skill already holds validated enforcement configs for Python (import-linter),
Go (depguard + `internal/`), Java/Kotlin (ArchUnit), C# (NetArchTest) and Rust (crate per layer).
Kotlin and Rust can make even more of the rules compile-time than TypeScript can: module/crate
boundaries per layer and sealed result types.
