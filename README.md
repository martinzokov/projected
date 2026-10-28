# projected

**CQRS services — event-sourced or state-based — where you write only the business logic.**

Developers and AI coding agents write events, decisions, commands, queries and handlers.
projected derives everything around them: HTTP endpoints shaped as business operations, input
validation, OpenAPI 3.1, typed clients, message consumers, PostgreSQL persistence with optimistic
concurrency, projections, access control, duplicate command protection and distributed tracing.
The hexagonal architecture is enforced by the compiler and by checks that fail the build, so
agent-written code cannot quietly erode it.

> **Two flavours, one framework.** Each project picks one in `projected.json` when it is created,
> and never changes it:
>
> | `"flavour"` | Aggregates are | A decision returns |
> |---|---|---|
> | `"event-sourced"` | folded from their events | the events that follow |
> | `"state-based"` | stored as their current state, with an outbox for events | the next state, optionally with events |
>
> Contracts, the HTTP and messaging protocol, transports, auth, idempotency, tracing and
> enforcement are identical: a caller cannot tell which flavour served it. The code below is
> event-sourced; [`school-state-based`](typescript/examples/school-state-based) is the same
> service in the other flavour.

```ts
// domain — a pure decision
export function enlist(state: StudentState, input: Enlistment): Decision<typeof Student, StudentAlreadyEnlisted> {
  if (state.status !== "unknown") return Result.err(new StudentAlreadyEnlisted({ studentId: input.studentId }));
  return Result.ok([StudentEnlisted(input)]);
}

// application — the contract, and its handler
export const EnlistStudent = defineCommand({
  type: "enlist-student",
  version: 2,
  access: { permissions: ["students:manage"] },
  input: z.object({ studentId: z.string(), firstname: z.string(), lastname: z.string(), joiningDate: z.iso.date() }),
  output: z.object({ studentId: z.string() }),
  errors: [StudentAlreadyEnlisted],
});

export const enlistStudent = (deps: { students: AggregateRepository<typeof Student> }): CommandHandler<typeof EnlistStudent> =>
  async (input, context) =>
    (await deps.students.execute(input.studentId, (state) => enlist(state, input), context)).map(() => ({ studentId: input.studentId }));
```

That is the whole feature. It is served as `POST /commands/enlist-student/version/2`, only to
callers holding `students:manage`. A broken rule comes back as
`200 {"status":"error","error":{"type":"StudentAlreadyEnlisted",...}}`, a retried request with
the same `Idempotency-Key` gets the original outcome instead of running twice, every step is
traced, the operation is documented in `openapi.json`, and it can be called in a batch, from
another service through a typed client, or through Kafka or NATS.

## Principles

- **Business operations, not resources.** APIs follow
  [*It's time to put REST to rest*](https://sollecitom.github.io/software-product-development-blog/posts/2023/2023-09-22-put-rest-to-rest/):
  `POST /commands/{type}/version/{n}`, `POST /queries/{type}/version/{n}`, batches, and HTTP
  status codes kept for the protocol, never for business outcomes.
- **Every operation version is immutable.** Evolve by adding a version; CI fails if a published
  one changes.
- **Failures are values.** [better-result](https://www.npmjs.com/package/better-result) Results
  everywhere: business errors are declared on contracts and checked at compile time,
  infrastructure errors map to protocol responses, defects are `Panic`s. Every driven port
  returns Results, and adapters may not await anything that can reject outside
  `fromDependency` — enforced by type-checked lint.
- **Boundaries fail the build.** Following
  [anti-slop](https://github.com/martinzokov/anti-slop): domain and application compile without
  DOM or Node, cross-layer imports are compile errors, dependency-cruiser and ESLint catch the
  rest, and every rule is tested by seeding a violation.
- **Language-neutral at the edges.** The protocol is a spec, not an implementation detail.
  TypeScript is first; other languages follow the same spec.

## Repository

| Path | What |
|---|---|
| [`spec/`](spec) | the language-neutral protocol ([`protocol.md`](spec/protocol.md)) and wire schemas |
| [`typescript/`](typescript) | the TypeScript implementation: packages and the school example in [each](typescript/examples/school-event-sourced) [flavour](typescript/examples/school-state-based) |
| [`skills/`](skills) | AI agent skills for building with projected |
| [`docs/`](docs) | [architecture and decisions](docs/architecture.md), [enforcement](docs/enforcement.md), [persistence](docs/persistence.md), [messaging](docs/messaging.md), [auth, idempotency and tracing](docs/cross-cutting.md), [third-party APIs](docs/vendors.md), [roadmap](docs/roadmap.md) |
| [`vendor/anti-slop/`](vendor/anti-slop) | vendored copy of anti-slop's skills and configs ([`UPSTREAM.md`](vendor/anti-slop/UPSTREAM.md)) |
| [`.claude/skills/`](.claude/skills) | links making all skills available to agents working in this repo |

## Getting started

Requires Node 22.12+ and pnpm 10; Docker for the integration tests.

```sh
cd typescript
pnpm install
pnpm check                  # build, lint, unit tests, and `projected check` on both examples
docker compose up -d --wait # Postgres, Kafka, NATS
pnpm test:integration       # every test, including the adapters against the real servers
```

Run an example service — in memory by default, or on real infrastructure:

```sh
cd typescript/examples/school-event-sourced      # or school-state-based
pnpm start                  # after pnpm build at the workspace root
DATABASE_URL=postgres://projected:projected@localhost:55432/projected \
KAFKA_BROKERS=localhost:9092 NATS_URL=nats://localhost:4222 pnpm start
```

See [the example's README](typescript/examples/school-event-sourced/README.md) for signing in and calling it.

## Packages

| Package | Layer | Purpose |
|---|---|---|
| `@projected/domain` | domain | Result, zod, `defineEvent`, `defineError`; `defineAggregate` per flavour (`/event-sourced`, `/state-based`) — pure, no I/O |
| `@projected/application` | application | contracts with access rules, handlers, ports (auth, idempotency, telemetry, documents), event handlers, dispatcher; the aggregate store port and repository per flavour |
| `@projected/http` | infrastructure | endpoints and OpenAPI derived from contracts, authenticators, typed `httpService`, Result-based `httpClient`; Node server in `@projected/http/node` |
| `@projected/messaging` | infrastructure | queued commands, consumers, event relay over a pluggable transport |
| `@projected/kafka` | infrastructure | Kafka transport (`@platformatic/kafka`) |
| `@projected/nats` | infrastructure | NATS JetStream transport — the lightweight broker |
| `@projected/store-memory` | infrastructure | in-memory checkpoints, idempotency, documents; event store or state store per flavour |
| `@projected/store-postgres` | infrastructure | PostgreSQL checkpoints, idempotency, documents; event store or state store with outbox per flavour; migrations |
| `@projected/auth-better-auth` | infrastructure | better-auth sessions as principals, its routes, OpenAPI security schemes |
| `@projected/opentelemetry` | infrastructure | the Telemetry port on OpenTelemetry |
| `@projected/runtime` | infrastructure | system clock, UUIDs, background event-handler polling |
| `@projected/testing` | tests | given/when/then, fixed clock, sequential ids, test authenticator and telemetry, conformance suites for every store and transport |
| `@projected/architecture` | tooling | layer tsconfig presets, dependency-cruiser and ESLint rules, layout check |
| `@projected/cli` | tooling | `projected check`, `arch`, `openapi`, `contracts`, `docs` (a service catalog with Mermaid diagrams, derived from the code), `vendor` (typed clients for third-party OpenAPI specs) |

## Skills for agents

| Skill | Use when |
|---|---|
| [`projected`](skills/projected/SKILL.md) | building any feature — the golden path and the rules |
| [`projected-domain-modelling`](skills/projected-domain-modelling/SKILL.md) | events, errors, aggregates, decisions, event versioning |
| [`projected-contracts`](skills/projected-contracts/SKILL.md) | commands, queries, naming, versioning, HTTP mapping |
| [`projected-integrations`](skills/projected-integrations/SKILL.md) | ports, adapters, projections, other services, messaging |
| [`projected-testing`](skills/projected-testing/SKILL.md) | what to test at each level, and how |
| [`hexagonal-architecture-enforcement`](vendor/anti-slop/skills/hexagonal-architecture-enforcement/SKILL.md) | (anti-slop) the boundary rules, per language |
| [`properties-of-good-tests`](vendor/anti-slop/skills/properties-of-good-tests/SKILL.md) | (anti-slop) what makes a test good |
