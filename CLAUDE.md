# Working on projected

projected is a framework *and* a set of rules for apps built with it. This file is for agents
changing the framework itself. To build an app feature (including in `typescript/examples/`),
load the `projected` skill.

## Layout

- `spec/` — language-neutral protocol (`protocol.md`, `wire.schema.json`). Normative.
- `typescript/` — pnpm workspace: `packages/*` (the framework) and `examples/*` (apps).
- `skills/` — distributable agent skills; `.claude/skills/` links to them and to `vendor/`.
- `vendor/anti-slop/` — vendored upstream. Never edit by hand: run `scripts/sync-anti-slop.sh`.
- `docs/` — architecture and decisions, enforcement table, roadmap.

## The gate

```sh
cd typescript && pnpm install && pnpm check
```

`pnpm check` = `tsc -b` + ESLint + vitest + `projected check` in every example. It must be green
before you finish. Individual steps: `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm exec vitest run <path>`.
The architecture fitness tests compile fixtures with `tsc -b`, so build before running them.

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
  against the schema.
- **New `EventStore` adapters must pass `eventStoreConformance`** from `@projected/testing`.
- **Public API changes update the skills and the example.** Skill snippets must compile against
  the real API; the school example is the reference app and must stay green under `projected check`.
- **Compile-time guarantees are tested with `@ts-expect-error`** in the package tests (a missing
  handler, an undeclared error, a missing evolve handler). Keep them when refactoring types.
- **Generated artifacts are regenerated, never hand-edited:** `projected openapi`,
  `projected contracts --update` in the example.

## Style

Match the surrounding code: small modules, doc comments on exported API that explain *why*,
messages in errors and rules written as instructions to whoever hits them. Tests follow the
vendored `properties-of-good-tests` skill: named as the behaviour, arrange–act–assert, no
shared mutable state.
