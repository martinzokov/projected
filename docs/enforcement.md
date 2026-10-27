# What is enforced, where, and how it is proven

Every rule below fails a build or a check — none is a convention. Each one has a test that seeds
a violation and asserts the check goes red
([`typescript/packages/architecture/test/architecture.test.ts`](../typescript/packages/architecture/test/architecture.test.ts),
plus the `@ts-expect-error` assertions in the package tests).

Run everything as CI does: `pnpm check` in `typescript/`, or `projected check` in an app.

## Tier 2 — the compiler

| Rule | Mechanism | Error you see |
|---|---|---|
| domain cannot import application or infrastructure | each layer is a `composite` TypeScript project; `src/domain` references nothing | `TS6307: File … is not listed within the file list of project` |
| application cannot import infrastructure | `src/application` references only `../domain` | `TS6307` |
| no `fetch`, `console`, timers, DOM in domain/application | presets set `lib: ["ES2023"]` | `TS2304` / `TS2584: Cannot find name 'console'` |
| no `node:*` modules or Node globals in domain/application | presets set `types: []` | `TS2591` / `TS2307` |
| every event has an `evolve` handler | mapped type over the aggregate's events | missing property |
| every contract has exactly one handler | `createApplication`'s handler map is keyed by `type@version` | missing / excess property |
| every service decides who may call it | `defineContracts` requires `access` | missing property |
| a handler returns only its contract's output, declared errors, or infrastructure errors | `Handler<C>` return type | not assignable |
| an event handler handles every event it subscribes to | mapped type over `events` | missing property |
| a remote call returns the remote contract's exact types | `RemoteService<C>` | — |

Presets: `@projected/architecture/tsconfig/{domain,application,infrastructure,test}.json`.

## Tier 1 — dependency-cruiser (imports)

Rules from `dependencyCruiserRules()` in `@projected/architecture`, derived from
[anti-slop's TypeScript config](../vendor/anti-slop/skills/hexagonal-architecture-enforcement/configs/dependency-cruiser.js).

| Rule | Forbids |
|---|---|
| `domain-is-pure` | domain → anything but `src/domain` and `@projected/domain` (other packages, node builtins, other layers) |
| `application-not-infrastructure` | application → infrastructure |
| `application-only-uses-the-kernel` | application → any package but `@projected/domain`, `@projected/application` (plus a configured allowlist) |
| `ports-are-pure-interfaces` | ports → use cases or anything outside domain/ports/kernels |
| `driving-adapters-use-driving-ports` | driving adapter → use case or driven port |
| `driven-adapters-implement-driven-ports` | driven adapter → use case or driving port |
| `adapters-are-independent` | adapter → any other adapter |
| `nothing-imports-config` | anything → the composition root |
| `test-code-stays-in-tests` | `src/` → `@projected/testing`, `vitest`, `test/` |
| `known-layers-only` | files outside the known layer folders |
| `no-circular` | import cycles |
| `not-to-unresolvable` | imports that do not resolve |

Type-only imports count (`tsPreCompilationDeps`), and symlinked workspace packages resolve the
same as installed ones (`preserveSymlinks`).

## Tier 1 — ESLint (code)

From `projectedEslint()` in `@projected/architecture/eslint`:

| Scope | Rule | Forbids |
|---|---|---|
| domain, application | `no-restricted-syntax` | `new Date()`, `Date.now()`, `Math.random()`, `throw`, `try` |
| domain | `no-restricted-syntax` | `async` functions, `await` |
| domain, application | `no-restricted-globals` | `fetch`, timers, `process`, `console`, `crypto`, `Buffer`, `require`, storage … |
| all of `src/` | `@typescript-eslint/ban-ts-comment` | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` |
| all of `src/` | `@typescript-eslint/no-explicit-any` | `any` |
| all of `src/` | `@typescript-eslint/triple-slash-reference` | `/// <reference types="node" />` and friends |
| all of `src/` | `linterOptions.noInlineConfig` | `eslint-disable` comments — ignored *and* reported |

## Layout and the guard rails themselves

`checkLayout()`:

| Rule | Forbids |
|---|---|
| `required-layers` | a missing `src/domain`, `src/application` or `src/infrastructure/config` |
| `known-layers-only` | any source file outside the layer folders |
| `typescript-only` | `.js`/`.mjs`/`.cjs` files in `src/` (they would escape the checks) |
| `layer-tsconfig` | a layer tsconfig that does not extend its preset, sets `lib`/`types`/`paths`/`baseUrl`/`typeRoots`/`noLib`/`allowJs`, includes `..`, or references anything but the layers below it |

`checkArchitecture()` also fails when dependency-cruiser or ESLint inspected zero files: several
of these tools pass silently when misconfigured, and a green run that checked nothing is the
worst possible outcome.

## Contracts

| Rule | Mechanism |
|---|---|
| published `(type, version)` never changes input, output, errors or access | `projected contracts` compares fingerprints with `contracts.lock.json` |
| a new operation is locked before merge | same check: unlocked operations fail |
| removing an operation is explicit | requires `--allow-removal` |
| re-baselining is explicit and reviewed | `--rebaseline`, for toolchain upgrades that change generated JSON Schema but not the wire contract — the `openapi.json` diff must show no change to a published operation |
| `openapi.json` matches the code | `projected openapi --check` |
| names are kebab-case (operations), PascalCase (events, errors), camelCase (aggregates) | checked when defined; the app fails at startup and in tests |
| contract schemas are JSON-compatible | checked when defined (`z.toJSONSchema` with `unrepresentable: "throw"`) |
| framework error tags are reserved | `defineError` refuses them |
| permissions are `resource:action` names, and `{ permissions: [] }` is refused | checked when defined |

## Runtime guarantees with conformance suites

Not static rules, but every adapter must demonstrate them against a real server:

| Suite | Holds |
|---|---|
| `eventStoreConformance` | optimistic concurrency, per-stream and global order, immutability |
| `checkpointStoreConformance` | positions per handler, beyond 32 bits |
| `idempotencyStoreConformance` | exactly one concurrent claim, replay, release, lock take-over, expiry |
| `documentStoreConformance` | equality filters, ordering, isolation, schema validation on read |
| `messageTransportConformance` | delivery, redelivery, dead letters, consumer groups, per-key order, durability |

The Postgres adapter also has a concurrent writer/reader test for global order that fails when
its ordering lock is removed.

## Protocol

`spec/wire.schema.json` is checked against real HTTP responses and real messages
(`packages/http/test/wire-spec.test.ts`, `packages/messaging/test/wire-spec.test.ts`), and the
generated OpenAPI documents are validated against the official OpenAPI 3.1 schema.
