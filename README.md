# projected

<p align="center"><img src="docs/assets/hero.png" alt="projected: your business logic at the core, everything else derived and enforced" width="100%"></p>

**The starter for agentic development that doesn't rot.**

Coding agents write code fast, and without guardrails the design erodes just as fast. projected
gives you TypeScript backend services where your agents write only the business logic, and the
build fails the moment they break the design. You describe what the business does; you review
small, readable changes; the codebase in month six is shaped like the one on day one.

It is opinionated on purpose. The choices are software craftsmanship ones, made once so neither
you nor your agents relitigate them: domain-driven design, hexagonal architecture, CQRS, failures
as values, immutable API versions, and tests that describe behaviour. More in
[principles](#principles) and [architecture and decisions](docs/architecture.md).

## Start with your agent

Give Claude Code, Codex, Cursor or another coding agent the `projected-start` skill:

```sh
npx skills add martinzokov/projected --skill projected-start
```

Then ask for the service in business terms:

> *Start a projected service for billing: customers get invoices, and an invoice can be issued
> once its lines are final.*

The agent creates the service with the [published CLI](https://www.npmjs.com/org/projected),
verifies it, installs the project's skills and guard hooks, builds the first feature and runs it.
You need Node 22.12+ and pnpm 10 or 11. Other ways to install the skill, and to start without an
agent, are in [Getting started](#getting-started).

## What you get

- **Agents write only the business.** A feature is a pure decision, a contract and a handler,
  with tests. HTTP endpoints, validation, OpenAPI 3.1, typed clients, PostgreSQL persistence,
  Kafka/NATS messaging, access control, duplicate-request protection and tracing come from the
  framework, so there is far less code to write, and to review.
- **The design can't quietly erode.** Layer boundaries are compile errors and `projected check`
  rules. `projected guard` runs in your agent's hooks as it edits and before it says it is done,
  so it fixes a broken rule while the change is fresh; a pre-commit hook stops any commit, by an
  agent or a person, that breaks one.
- **Agents know the way.** Shipped skills tell them how to build each kind of change, and
  generators write the stubs and tests they fill in. Names stay in business language: the
  generators refuse CRUD verbs.
- **APIs don't break by accident.** Every published operation version is locked, and CI fails if
  one changes; you evolve an API by adding a version.
- **It is a real service from the first command.** Tests, OpenAPI, auth, health checks and
  PostgreSQL work before you write a line.

## What a feature looks like

> **Two flavours, one framework.** Each project picks one in `projected.json` when it is created,
> and never changes it:
>
> | `"flavour"` | Aggregates are | A decision returns |
> |---|---|---|
> | `"state-based"` (the usual choice) | stored as their current state, with an outbox for events | the next state, optionally with events |
> | `"event-sourced"` (when you need full history) | folded from their events | the events that follow |
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
| [`spec/`](spec) | the language-neutral protocol ([`protocol.md`](spec/protocol.md)), wire schemas, and black-box [conformance suites](spec/conformance) any implementation can be run against |
| [`typescript/`](typescript) | the TypeScript implementation: packages, the school example in [each](typescript/examples/school-event-sourced) [flavour](typescript/examples/school-state-based), and a [banking ledger](typescript/examples/ledger) pilot with a load test |
| [`skills/`](skills) | AI agent skills for building with projected |
| [`docs/`](docs) | [architecture and decisions](docs/architecture.md), [enforcement](docs/enforcement.md), [persistence](docs/persistence.md), [messaging](docs/messaging.md), [auth, idempotency and tracing](docs/cross-cutting.md), [third-party APIs](docs/vendors.md), [running a service](docs/operations.md) (health, shutdown, metrics, operator tasks), [coding agents](docs/agents.md) (starting a project, guard, hooks, evals), [releasing](docs/releasing.md), [roadmap](docs/roadmap.md) |
| [`vendor/anti-slop/`](vendor/anti-slop) | vendored copy of anti-slop's skills and configs ([`UPSTREAM.md`](vendor/anti-slop/UPSTREAM.md)) |
| [`.claude/skills/`](.claude/skills) | links making all skills available to agents working in this repo |

## Getting started

Requires Node 22.12+ and pnpm 10 or 11. The packages are on npm as
[`@projected/*`](https://www.npmjs.com/org/projected).

### With a coding agent

[Above](#start-with-your-agent). The [`projected-start`](skills/projected-start/SKILL.md) skill
can also be copied by hand or read straight from unpkg without installing it; see
[coding agents](docs/agents.md#starting-a-project).

### By hand

```sh
npx @projected/cli@latest new service billing --flavour state-based --aggregate invoice
cd billing && git init
pnpm install && pnpm openapi && pnpm lock && pnpm catalog && pnpm check
pnpm exec projected agents install          # skills, AGENTS.md and guard hooks for coding agents
pnpm exec projected new command issue-invoice --aggregate invoice --event InvoiceIssued
pnpm build && pnpm start                    # http://localhost:3000, in memory; DATABASE_URL for PostgreSQL
```

The generated code compiles, passes `projected check` and has tests from the first command. The
service's README lists the generators; the [`projected`](skills/projected/SKILL.md) skill walks
through a feature.

### Working on the framework

```sh
cd typescript
pnpm install
pnpm check                  # build, lint, unit tests, and `projected check` on every example
docker compose up -d --wait # Postgres, Kafka, NATS
pnpm test:integration       # every test, including the adapters against the real servers
```

Inside the workspace, `projected new service` makes a service that depends on the workspace's
packages instead of released ones:

```sh
cd typescript
pnpm projected new service examples/billing --flavour state-based --aggregate invoice
pnpm install && pnpm build
cd examples/billing && pnpm openapi && pnpm lock && pnpm catalog && pnpm check
```

Run an example service — in memory by default, or on real infrastructure:

```sh
cd typescript/examples/school-event-sourced      # or school-state-based
pnpm start                  # after pnpm build at the workspace root
DATABASE_URL=postgres://projected:projected@localhost:55432/projected \
KAFKA_BROKERS=localhost:9092 NATS_URL=nats://localhost:4222 pnpm start
```

See [the example's README](typescript/examples/school-event-sourced/README.md) for signing in and
calling it, and [releasing](docs/releasing.md) for publishing the packages.

## Packages

| Package | Layer | Purpose |
|---|---|---|
| `@projected/domain` | domain | Result, zod, `defineEvent`, `defineError`; `defineAggregate` per flavour (`/event-sourced`, `/state-based`) — pure, no I/O |
| `@projected/application` | application | contracts with access rules, handlers, ports (auth, idempotency, telemetry, documents), event handlers, dispatcher; the aggregate store port and repository per flavour |
| `@projected/http` | infrastructure | endpoints and OpenAPI derived from contracts, authenticators, typed `httpService`, Result-based `httpClient`; hosted in Hono by a generated service (CORS, security headers, body limit), or bare in `@projected/http/node` |
| `@projected/messaging` | infrastructure | queued commands, consumers, event relay over a pluggable transport |
| `@projected/kafka` | infrastructure | Kafka transport (`@platformatic/kafka`) |
| `@projected/nats` | infrastructure | NATS JetStream transport — the lightweight broker |
| `@projected/store-memory` | infrastructure | in-memory checkpoints, idempotency, documents; event store or state store per flavour |
| `@projected/store-postgres` | infrastructure | PostgreSQL checkpoints, idempotency, documents; event store or state store with outbox per flavour; typed queries (Kysely) and migrators for its tables |
| `@projected/auth-better-auth` | infrastructure | better-auth sessions as principals, its routes, OpenAPI security schemes, a migrator for its tables |
| `@projected/auth-jwt` | infrastructure | bearer JWTs from any OpenID Connect or OAuth issuer (Auth0, Clerk, Cognito, Keycloak, WorkOS, Entra ID) as principals |
| `@projected/opentelemetry` | infrastructure | the Telemetry port on OpenTelemetry |
| `@projected/runtime` | infrastructure | system clock, UUIDs, JSON logs, background event-handler polling, event-handler lag gauges, graceful shutdown, tables ready at start |
| `@projected/testing` | tests | given/when/then, property-based tests from zod schemas (fast-check), fixed clock, sequential ids, test authenticator, telemetry and logger, conformance suites for every store and transport |
| `@projected/architecture` | tooling | layer tsconfig presets, dependency-cruiser and ESLint rules, layout check |
| `@projected/cli` | tooling | `projected new` (a service, aggregates, commands, queries, ports and event handlers, wired and tested), `check`, `arch`, `openapi`, `contracts`, `docs` (a service catalog with Mermaid diagrams, derived from the code), `vendor` (typed clients for third-party OpenAPI specs), `mutate` (mutation testing with Stryker), `operate` (operator tasks on a running service), `migrate` (tables up to date as a deploy step), `guard` and `agents install` (checks and hooks for coding agents), `conformance` (the black-box suites against a running service) |

## Skills for agents

| Skill | Use when |
|---|---|
| [`projected-start`](skills/projected-start/SKILL.md) | there is no project yet — from a business idea to a running, agent-ready service |
| [`projected`](skills/projected/SKILL.md) | building any feature — the golden path and the rules |
| [`projected-domain-modelling`](skills/projected-domain-modelling/SKILL.md) | events, errors, aggregates, decisions, event versioning |
| [`projected-contracts`](skills/projected-contracts/SKILL.md) | commands, queries, naming, versioning, HTTP mapping |
| [`projected-integrations`](skills/projected-integrations/SKILL.md) | ports, adapters, projections, other services, messaging |
| [`projected-testing`](skills/projected-testing/SKILL.md) | what to test at each level, and how |
| [`hexagonal-architecture-enforcement`](vendor/anti-slop/skills/hexagonal-architecture-enforcement/SKILL.md) | (anti-slop) the boundary rules, per language |
| [`properties-of-good-tests`](vendor/anti-slop/skills/properties-of-good-tests/SKILL.md) | (anti-slop) what makes a test good |
