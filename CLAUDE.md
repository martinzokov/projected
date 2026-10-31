# Working on projected

projected is a framework *and* a set of rules for apps built with it. This file is for agents
changing the framework itself. To build an app feature (including in `typescript/examples/`),
load the `projected` skill.

## Layout

- `spec/` — language-neutral protocol (`protocol.md`, `wire.schema.json`). Normative.
- `typescript/` — pnpm workspace: `packages/*` (the framework) and `examples/*` (apps: the school
  in each flavour, and the banking `ledger` pilot with its load test, `pnpm load`).
- `skills/` — distributable agent skills; `.claude/skills/` links to them and to `vendor/`.
- `vendor/anti-slop/` — vendored upstream. Never edit by hand: run `scripts/sync-anti-slop.sh`.
- `docs/` — architecture and decisions, enforcement table, releasing, roadmap.

## Two flavours

Projects are event-sourced or state-based (`"flavour"` in `projected.json`, fixed at creation).
Packages keep shared code at their root and flavour-specific code under `src/event-sourced/` and
`src/state-based/`, exported as `@projected/<package>/<flavour>`; each flavour entry point
re-exports the shared API. A change to shared behaviour must keep both flavours green; a change
to one flavour usually has a counterpart in the other (and in both school examples).

## The gate

```sh
cd typescript && pnpm install && pnpm check
```

`pnpm check` = `tsc -b` + ESLint + vitest + `projected check` in every example. It must be green
before you finish. Individual steps: `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm exec vitest run <path>`.
The architecture fitness tests compile fixtures with `tsc -b`, so build before running them.
`pnpm mutate` mutation-tests every example (slow; CI runs it): a change to `@projected/testing` or
to an example's tests must keep their scores above the threshold in their `projected.json`. A change to the event store,
the repository or event handling should keep the ledger's load test green, and not slower.

Adapter tests against real servers are skipped unless their variables are set. When you touch a
store or transport, run them too:

```sh
docker compose up -d --wait   # in typescript/: Postgres :55432, Kafka :9092, NATS :4222
pnpm test:integration         # sets PROJECTED_TEST_DATABASE_URL, _KAFKA_BROKERS, _NATS_URL
```

`pnpm evals` (on demand: needs Claude Code, Codex or Cursor signed in) gives real agents the tasks
in `typescript/evals/tasks/` and grades what they leave. Run it after changing a skill, a
generator or a rule's message.

## Rules for framework changes

- **TypeScript stays on 6.0.x.** TypeScript 7 has no JavaScript compiler API; typescript-eslint
  and dependency-cruiser need it.
- **`@projected/domain` and `@projected/application` stay pure.** They compile with
  `lib: ["ES2023"]` and `types: []` (see `tsconfig.base.json`) — no Node, no DOM, no I/O. Anything
  that needs the platform belongs in an infrastructure package.
- **Results, not exceptions,** on every public path. `panic(...)` only for programmer errors
  detected at definition or startup time (bad names, missing handlers) and for broken invariants.
- **A new enforcement rule needs a fitness test** in `packages/architecture/test/architecture.test.ts`
  that seeds a violation and asserts the rule name. A rule never seen failing is not trusted.
- **The protocol and the code move together.** Change `spec/protocol.md` and
  `spec/wire.schema.json` with the HTTP/messaging adapters; the wire-spec tests check real output
  against the schema. A new observable promise gets a scenario in `spec/conformance/` — HTTP only,
  nothing a language has to special-case — which both school examples must pass.
- **Every store and transport passes its conformance suites** from `@projected/testing`
  (`eventStoreConformance` or `stateStoreConformance`, `checkpointStoreConformance`, `idempotencyStoreConformance`,
  `documentStoreConformance`, `messageTransportConformance`), against a real server. A new
  guarantee goes into the suite, not into one adapter's tests.
- **Adapters never throw.** Map driver failures to `DependencyUnavailable` /
  `DependencyFailure`, conflicts to `ConcurrencyConflict`.
- **Cross-cutting behaviour belongs in the dispatcher**, not in transports: access checks,
  idempotency and operation spans apply to HTTP and messaging through the same path.
- **Public API changes update the skills and the examples.** Skill snippets must compile against
  the real API; the school examples are the reference apps and must stay green under `projected check`.
- **Compile-time guarantees are tested with `@ts-expect-error`** in the package tests (a missing
  handler, an undeclared error, a missing evolve handler, an incomplete state). Keep them when
  refactoring types.
- **Templates are code.** What `projected new` writes (`packages/cli/src/scaffold/`) must compile,
  pass `projected check --strict` and its own tests in both flavours; `scaffold.test.ts` grows a
  service with every generator and runs all three. Change a template with the examples it mirrors.
- **`skills/projected-start` drives the published CLI** for an agent with no project yet. A change
  to `projected new service`, its next steps or what a fresh service needs updates that skill too;
  it ships inside `@projected/cli`, so it reaches users with the next release.
- **Packages are released in lockstep** (`docs/releasing.md`): a new service depends on every
  framework package at the CLI's version. Try a release from packed tarballs outside the repository
  first: the workspace hides missing files and undeclared dependencies.
- **Generated artifacts are regenerated, never hand-edited:** `projected openapi`,
  `projected contracts --update` and `projected docs` in the examples, `projected vendor generate`
  for vendor clients.

## Style

Match the surrounding code: small modules, doc comments on exported API that explain *why*,
messages in errors and rules written as instructions to whoever hits them. Tests follow the
vendored `properties-of-good-tests` skill: named as the behaviour, arrange–act–assert, no
shared mutable state.
