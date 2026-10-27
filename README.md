# projected

**Event-sourced, CQRS services where you write only the business logic.**

Developers and AI coding agents write events, decisions, commands, queries and handlers.
projected derives everything around them: HTTP endpoints shaped as business operations, input
validation, OpenAPI 3.1, typed clients, message consumers, persistence with optimistic
concurrency, and projections. The hexagonal architecture is enforced by the compiler and by
checks that fail the build, so agent-written code cannot quietly erode it.

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
  input: z.object({ studentId: z.string(), firstname: z.string(), lastname: z.string(), joiningDate: z.iso.date() }),
  output: z.object({ studentId: z.string() }),
  errors: [StudentAlreadyEnlisted],
});

export const enlistStudent = (deps: { students: AggregateRepository<typeof Student> }): CommandHandler<typeof EnlistStudent> =>
  async (input, context) =>
    (await deps.students.execute(input.studentId, (state) => enlist(state, input), context)).map(() => ({ studentId: input.studentId }));
```

That is the whole feature. It is served as `POST /commands/enlist-student/version/2`. A broken
rule comes back as `200 {"status":"error","error":{"type":"StudentAlreadyEnlisted",...}}`, the
operation is documented in `openapi.json`, and it can be called in a batch, from another service
through a typed client, or through a message queue.

## Principles

- **Business operations, not resources.** APIs follow
  [*It's time to put REST to rest*](https://sollecitom.github.io/software-product-development-blog/posts/2023/2023-09-22-put-rest-to-rest/):
  `POST /commands/{type}/version/{n}`, `POST /queries/{type}/version/{n}`, batches, and HTTP
  status codes kept for the protocol, never for business outcomes.
- **Every operation version is immutable.** Evolve by adding a version; CI fails if a published
  one changes.
- **Failures are values.** [better-result](https://www.npmjs.com/package/better-result) Results
  everywhere: business errors are declared on contracts and checked at compile time,
  infrastructure errors map to protocol responses, defects are `Panic`s.
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
| [`typescript/`](typescript) | the TypeScript implementation: packages and the [school example](typescript/examples/school) |
| [`skills/`](skills) | AI agent skills for building with projected |
| [`docs/`](docs) | [architecture and decisions](docs/architecture.md), [enforcement](docs/enforcement.md), [roadmap](docs/roadmap.md) |
| [`vendor/anti-slop/`](vendor/anti-slop) | vendored copy of anti-slop's skills and configs ([`UPSTREAM.md`](vendor/anti-slop/UPSTREAM.md)) |
| [`.claude/skills/`](.claude/skills) | links making all skills available to agents working in this repo |

## Getting started

Requires Node 22.12+ and pnpm 10.

```sh
cd typescript
pnpm install
pnpm check          # build, lint, test, and `projected check` on the example
```

Run the example service:

```sh
cd typescript/examples/school
pnpm start          # after pnpm build at the workspace root
curl -s localhost:3000/commands/enlist-student/version/2 -H 'content-type: application/json' \
  -d '{"studentId":"s-1","firstname":"Bruce","lastname":"Wayne","joiningDate":"2023-09-22"}'
curl -s localhost:3000/queries/enlisted-students-on-joining-date/version/1 -H 'content-type: application/json' \
  -d '{"date":"2023-09-22"}'
```

## Packages

| Package | Layer | Purpose |
|---|---|---|
| `@projected/domain` | domain | Result, zod, `defineEvent`, `defineError`, `defineAggregate` — pure, no I/O |
| `@projected/application` | application | `defineCommand`/`defineQuery`/`defineContracts`, handlers, ports, repository, event handlers, dispatcher |
| `@projected/http` | infrastructure | endpoints and OpenAPI derived from contracts, typed `httpService`, Result-based `httpClient`; Node server in `@projected/http/node` |
| `@projected/messaging` | infrastructure | queued commands, consumers, event relay over a pluggable transport |
| `@projected/store-memory` | infrastructure | in-memory event and checkpoint stores |
| `@projected/runtime` | infrastructure | system clock, UUIDs, background event-handler polling |
| `@projected/testing` | tests | given/when/then, fixed clock, sequential ids, event store conformance suite |
| `@projected/architecture` | tooling | layer tsconfig presets, dependency-cruiser and ESLint rules, layout check |
| `@projected/cli` | tooling | `projected check`, `arch`, `openapi`, `contracts` |

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
