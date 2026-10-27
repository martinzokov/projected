---
name: hexagonal-architecture-enforcement
description: "Use when setting up or working in a hexagonal / ports-and-adapters codebase. Layer boundaries — including the driving/driven split — must be enforced by a linter or the compiler, never by convention. Ships per-language configs for TypeScript, Python, Go, Java, C# and Rust, each validated against a working fixture."
category: software-development
---

# Hexagonal Architecture, Machine-Enforced

*(Alistair Cockburn's Ports & Adapters; Jeffrey Palermo's Onion; Robert C. Martin's Clean Architecture — same dependency rule, three names.)*

**The rule:** dependencies point inward. Domain knows nothing. Application knows domain. Infrastructure knows application and domain. Nothing inner ever imports anything outer.

**The principle this skill exists for:** a boundary that is only written down in a README is not a boundary. An agent (or a human at 4pm on a Friday) will add `from myapp.infrastructure.adapter.driven.persistence import session` inside a domain entity, the tests will pass, and the architecture will be gone six months later. The boundary must fail the build.

---

## 1. The Structure

```
src/
├── domain/
│   ├── model/          Order, Payment, Money
│   ├── service/        domain services (logic spanning entities)
│   ├── event/          OrderPlaced
│   └── exception/      OrderNotFound
│
├── application/
│   ├── usecase/        PlaceOrder, RefundPayment          — implementations
│   └── port/
│       ├── driving/    PlaceOrderUseCase,                 — inbound interfaces
│       │               RefundPaymentUseCase                 (what the app offers)
│       └── driven/     OrderRepository, PaymentGateway,   — outbound interfaces
│                       EventPublisher                       (what the app needs)
│
└── infrastructure/
    ├── adapter/
    │   ├── driving/    web/OrderController                — calls the app
    │   │               messaging/OrderMessageConsumer
    │   └── driven/     persistence/PostgresOrderRepository — the app calls it
    │                   payment/StripePaymentGateway
    │                   messaging/KafkaEventPublisher
    └── config/         DatabaseConfig, ApplicationConfig  — composition root
```

The dependency rules this shape implies:

| From | May import | May NOT import |
|---|---|---|
| `domain/**` | `domain` only | everything else — including npm/PyPI packages and node builtins |
| `application/port/**` | `domain`, other ports | `usecase`, all infrastructure |
| `application/usecase/**` | `domain`, both port sides, other use cases | all infrastructure, all frameworks |
| `infrastructure/adapter/driving/<x>/` | `domain`, `port/driving` | `usecase`, `port/driven`, every other adapter |
| `infrastructure/adapter/driven/<x>/` | `domain`, `port/driven` | `usecase`, `port/driving`, every other adapter |
| `infrastructure/config/**` | everything | — it is the one place allowed to know all layers |
| anything | — | `infrastructure/config` (nothing may import the composition root) |

Four rules people forget, all of them enforceable:

- **Driving adapters go through `port/driving`, never through `usecase`.** A controller importing `PlaceOrder` (the class) instead of `PlaceOrderUseCase` (the interface) couples the transport to the implementation and quietly makes the driving port dead code.
- **Driven adapters implement `port/driven` and nothing else.** A repository importing a use case is a cycle in disguise.
- **Ports never import use cases.** The use case implements the driving port, not the reverse. If this edge exists, the inversion is upside down.
- **Adapters do not know each other** — not siblings on the same side (`web` ↛ `messaging`), and not across the line (`web` ↛ `persistence`). This is how a "hexagonal" codebase that passes the vertical layer check still becomes a ball of mud.

And one naming rule no linter can check: **the port is named for what the application needs, not for what implements it.** `OrderRepository`, not `PostgresOrderRepository`, in `port/driven/`. If your port names its adapter, the boundary already leaked.

---

## 2. Three Enforcement Tiers

Pick the strongest tier your stack allows. They compose — tier 3 does not remove the need for tier 1's fast local feedback.

| Tier | Mechanism | Feedback | Bypassable |
|---|---|---|---|
| 1. Lint | import-linter, dependency-cruiser, eslint-plugin-boundaries, ArchUnit | seconds, local | yes (`# noqa`, disable comment) — so ban the bypass in CI |
| 2. Compiler / resolver | separate packages or modules; the inner package does not depend on the outer one, so the import cannot resolve | build time | no |
| 3. Build graph | Gradle/Bazel/Cargo/Nx module dependencies declared explicitly | build time, whole-repo | no |

Tier 2 is the goal: `domain` as its own package with an empty dependency list means `import infrastructure` is not a lint violation, it is an unresolvable name. **Prefer physical separation over rule files whenever the packaging cost is acceptable.** The tree above maps onto packages directly — `domain`, `application`, `infrastructure` become three packages, with `config` as a fourth that depends on all of them.

---

## 3. TypeScript

### Tier 1 — dependency-cruiser (recommended: sees `import type`, node builtins, and npm packages in one rule)

Full config at `configs/dependency-cruiser.js`. The load-bearing rules:

```js
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment: "src/domain may only import from src/domain. No application, no " +
               "infrastructure, no npm, no node builtins.",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { pathNot: "^src/domain/" },
    },
    {
      name: "ports-are-pure-interfaces",
      comment: "A port may only reference the domain and other ports. The use case " +
               "implements the driving port, not the other way round.",
      severity: "error",
      from: { path: "^src/application/port/" },
      to: { pathNot: "^(src/application/port/|src/domain/)" },
    },
    {
      name: "driving-adapters-use-driving-ports",
      comment: "A controller or consumer may only call the application through " +
               "src/application/port/driving.",
      severity: "error",
      from: { path: "^src/infrastructure/adapter/driving/" },
      to: { path: "^src/application/(usecase|port/driven)/" },
    },
    {
      name: "driven-adapters-implement-driven-ports",
      severity: "error",
      from: { path: "^src/infrastructure/adapter/driven/" },
      to: { path: "^src/application/(usecase|port/driving)/" },
    },
    {
      name: "adapters-are-independent",
      comment: "An adapter may not import another adapter — same side or across.",
      severity: "error",
      from: { path: "^src/infrastructure/adapter/(driving|driven)/([^/]+)/" },
      to: {                                  // $1 = side, $2 = adapter name:
        path: "^src/infrastructure/adapter/(driving|driven)/([^/]+)/",
        pathNot: "^src/infrastructure/adapter/$1/$2/",   // 'any adapter but my own'
      },
    },
    {
      name: "nothing-imports-config",
      severity: "error",
      from: { pathNot: "^src/infrastructure/config/" },
      to: { path: "^src/infrastructure/config/" },
    },
  ],
  options: { tsPreCompilationDeps: true, doNotFollow: { path: "node_modules" } },
};
```

Two techniques worth lifting:

- **The `$1`/`$2` back-references** express "any adapter other than my own" in one rule instead of N². With two capture groups they cover both the same-side sibling case and the driving↔driven case.
- **`domain-is-pure` is written as "may import nothing outside `src/domain`"**, not as a list of banned packages. One rule covers infrastructure, npm packages, and node builtins at once, and it stays correct when someone adds a dependency you never thought to ban.

Run: `npx depcruise src --config .dependency-cruiser.js`

**`typescript` must be installed in the project** (`npm i -D typescript`). Without it dependency-cruiser cruises 0 modules and prints `✔ no dependency violations found` — a green check that enforces nothing.

### Tier 1 alternative — eslint-plugin-boundaries

Use when you want violations inline in the editor and in the same ESLint run as everything else. Full config at `configs/eslint.boundaries.mjs`. It classifies files into elements first, then enumerates the legal edges:

```js
settings: {
  "import/resolver": { typescript: { alwaysTryTypes: true } },
  "boundaries/elements": [
    { type: "domain",       pattern: "src/domain/**" },
    { type: "port-driving", pattern: "src/application/port/driving/**" },
    { type: "port-driven",  pattern: "src/application/port/driven/**" },
    { type: "usecase",      pattern: "src/application/usecase/**" },
    { type: "adapter",      pattern: "src/infrastructure/adapter/*/*/**",
                            capture: ["side", "adapterName"] },
    { type: "config",       pattern: "src/infrastructure/config/**" },
  ],
},
rules: {
  "boundaries/dependencies": ["error", {
    default: "disallow",                    // enumerate legal edges; else error
    policies: [
      { from: { element: { type: "domain" } },
        allow: { to: { element: { type: "domain" } } } },
      { from: { element: { type: "adapter", captured: { side: "driving" } } },
        allow: { to: { element: { types: { anyOf: ["domain", "port-driving"] } } } } },
      { from: { element: { type: "adapter", captured: { side: "driven" } } },
        allow: { to: { element: { types: { anyOf: ["domain", "port-driven"] } } } } },
      { from: { element: { type: "adapter" } },       // ...and only its OWN folder
        allow: { to: { element: { type: "adapter", captured: {
          side: "{{from.captured.side}}",
          adapterName: "{{from.captured.adapterName}}" } } } } },
      // ...ports, usecase, config
    ],
  }],
}
```

`captured: { side: "driving" }` on the `from` selector is what makes the driving/driven asymmetry expressible; `{{from.captured.*}}` templating is what keeps adapter independence to one policy.

Three things that make this config fail *open* — green run, zero enforcement:

- **No TS parser** in `languageOptions` — every file is a parse error and no boundary rule runs.
- **No `settings["import/resolver"].typescript`** — extensionless imports don't resolve, every dependency is classified "unknown", and the policies never fire. This one looks exactly like a clean codebase. Enable `boundaries/no-unknown-dependencies` so it surfaces as errors instead of silence.
- **`boundaries/dependencies` governs first-party elements only.** Third-party packages need the separate `boundaries/external` rule (`{ from: ["domain"], disallow: ["*"] }`) — without it a domain entity may freely import an ORM, which is the leak that matters most.

### Tier 2 — workspace packages

```
packages/
  domain/          package.json — "dependencies": {}
  application/     depends on @app/domain
  adapter-web/     depends on @app/application, @app/domain
  adapter-pg/      depends on @app/application, @app/domain
  config/          depends on all of them
```

`import { PostgresOrderRepository } from "@app/adapter-pg"` inside `packages/domain` then fails module resolution. No rule file, no bypass. Add TS project references (`composite: true` + `references`) so `tsc -b` enforces the same graph and rejects cycles.

Note what tier 2 costs you: package boundaries can express the vertical rule and adapter independence, but not the driving/driven port split *within* `application` — that stays a lint rule. Run both.

---

## 4. Python

### Tier 1 — import-linter

Full config at `configs/.importlinter`. Nine contracts, each doing a distinct job:

```ini
[importlinter]
root_package = myapp
include_external_packages = True

[importlinter:contract:layers]
name = Hexagonal layers
type = layers
containers =
    myapp
layers =
    infrastructure
    application
    domain
exhaustive = True

[importlinter:contract:application-layers]
name = Use cases depend on ports, never the reverse
type = layers
containers =
    myapp.application
layers =
    usecase
    port
exhaustive = True

[importlinter:contract:driving-adapters]
name = Driving adapters enter through driving ports only
type = forbidden
source_modules =
    myapp.infrastructure.adapter.driving
forbidden_modules =
    myapp.application.usecase
    myapp.application.port.driven

[importlinter:contract:driven-adapters]
name = Driven adapters implement driven ports only
type = forbidden
source_modules =
    myapp.infrastructure.adapter.driven
forbidden_modules =
    myapp.application.usecase
    myapp.application.port.driving

[importlinter:contract:adapter-independence]
name = Adapters do not know each other
type = independence
modules =
    myapp.infrastructure.adapter.driving.web
    myapp.infrastructure.adapter.driving.messaging
    myapp.infrastructure.adapter.driven.persistence
    myapp.infrastructure.adapter.driven.payment
    myapp.infrastructure.adapter.driven.messaging

[importlinter:contract:composition-root]
name = Nothing imports the composition root
type = forbidden
source_modules =
    myapp.domain
    myapp.application
    myapp.infrastructure.adapter
forbidden_modules =
    myapp.infrastructure.config

[importlinter:contract:domain-purity]
name = Domain imports no infrastructure
type = forbidden
source_modules =
    myapp.domain
forbidden_modules =
    sqlalchemy
    django
    fastapi
    requests
    boto3
    redis
    kafka
    stripe
    psycopg2
```

What each contract type buys you:

- **`layers`** — the vertical rule. Listed **highest first**; each layer may import those below, never above. Note it is used *twice*: once for the three top-level layers, once inside `myapp.application` to make `usecase` sit above `port`. That second contract is what stops a port importing a use case.
- **`exhaustive = True`** — any other module inside the container must be listed in `exhaustive_ignores` or the check fails. Without it, an agent creating `myapp/services/` invents a fourth unpoliced layer. Note `exhaustive` **requires `containers`**, and layers are then named relative to the container (`domain`, not `myapp.domain`) — the container-less form is a config error, not a silent no-op.
- **`independence`** — the sibling-adapter rule, across all five leaf adapters at once.
- **`forbidden`** — everything the layer graph can't express: the driving/driven asymmetry, the composition root, and framework purity.
- **`forbidden` against external packages** — the layers contract only sees `myapp.*` and will happily let a domain entity import `sqlalchemy`. Requires `include_external_packages = True`.

Add a `domain-layers` contract (`service` > `event` > `model` > `exception`) if you want the domain's internal ordering enforced too — it is in the shipped config, marked optional.

Run: `lint-imports` (exit code 1 on violation).

### Tier 2 — separate distributions

Split into `src/myapp_domain`, `src/myapp_application`, `src/myapp_infrastructure`, each with its own `pyproject.toml` and explicit `dependencies`. Installed with `uv pip install -e`, an illegal import raises `ModuleNotFoundError` at import time and fails test collection.

---

## 5. Go

Go gives you two boundaries before any config: `internal/` is compiler-enforced against outside modules, and **import cycles are a compile error**. That second one matters more than it sounds — in a wired application, most inward-pointing violations (domain→infrastructure, port→usecase) are *already* cycles, so `go build` rejects them before any linter runs. depguard's job is the violations that are not cycles: frameworks in the domain, adapter↔adapter imports, and driving-adapter→usecase.

Full config at `configs/golangci-arch.yml` (golangci-lint schema v2). Merge into your existing `.golangci.yml`.

```yaml
version: "2"
linters:
  default: none
  enable: [depguard]
  settings:
    depguard:
      rules:
        domain:
          files: ["**/internal/domain/**"]
          deny:
            - pkg: github.com/acme/app/internal/infrastructure
              desc: "domain must not import infrastructure — declare a driven port instead."
            - pkg: database/sql
              desc: "domain must not know about persistence."
        driving-adapters:
          files: ["**/internal/infrastructure/adapter/driving/**"]
          deny:
            - pkg: github.com/acme/app/internal/application/usecase
              desc: "enter through application/port/driving — importing the use case type welds transport to implementation."
            - pkg: github.com/acme/app/internal/application/port/driven
              desc: "a driving adapter must not use driven ports — that is upside down."
        composition-root:
          files: ["**/internal/**", "!**/internal/infrastructure/config/**"]
          deny:
            - pkg: github.com/acme/app/internal/infrastructure/config
              desc: "nothing may import the composition root."
```

`desc` is printed verbatim on violation — write it as an instruction to whoever hits it. The `!` prefix in `files` excludes a path, which is how the composition-root rule exempts the composition root itself.

Adapter independence needs one rule per adapter: depguard denies by package *prefix* and has no back-references, and a blanket `.../adapter` prefix would also flag an adapter importing its own subpackage. The shipped config spells out all five.

Run: `golangci-lint run ./...` — and `golangci-lint config verify` to catch schema mistakes.

---

## 6. Java / Kotlin

ArchUnit is the strongest tier-1 tool on any stack, for one reason: **it reads bytecode, not imports.** A domain class carrying `@Entity` has no import of your infrastructure at all, and every import-based linter misses it. ArchUnit sees the annotation, the field types, the constructor parameters and the generic arguments.

Full test class at `configs/HexagonalArchitectureTest.java`. Add `testImplementation("com.tngtech.archunit:archunit-junit5:1.4.1")` and it runs as an ordinary JUnit 5 test.

```java
@AnalyzeClasses(packages = "com.acme")
public class HexagonalArchitectureTest {

    @ArchTest
    static final ArchRule hexagonal_layers = Architectures.onionArchitecture()
            .domainModels("com.acme.domain.model..")
            .domainServices("com.acme.domain.service..", "com.acme.domain.event..",
                            "com.acme.domain.exception..")
            .applicationServices("com.acme.application..")
            .adapter("web",         "com.acme.infrastructure.adapter.driving.web..")
            .adapter("consumer",    "com.acme.infrastructure.adapter.driving.messaging..")
            .adapter("persistence", "com.acme.infrastructure.adapter.driven.persistence..")
            .adapter("payment",     "com.acme.infrastructure.adapter.driven.payment..")
            .adapter("publisher",   "com.acme.infrastructure.adapter.driven.messaging..")
            .withOptionalLayers(false);

    // onionArchitecture() covers the vertical rule AND adapter independence, but
    // treats all of `application` as one layer — so the port split needs its own rules.
    @ArchTest
    static final ArchRule driving_adapters_enter_through_driving_ports =
            noClasses().that().resideInAPackage("..infrastructure.adapter.driving..")
                    .should().dependOnClassesThat().resideInAnyPackage(
                            "..application.usecase..", "..application.port.driven..");
}
```

Two settings that decide whether this is real enforcement:

- **`withOptionalLayers(false)`** — an empty layer becomes a failure instead of a silent pass. Without it, a typo in a package identifier makes the rule vacuously true and everything stays green.
- **`@AnalyzeClasses(packages = ...)`** excludes test classes by default. If you customise the import, keep `ImportOption.DoNotIncludeTests` or your own fixtures will trip the rules.

Tier 2: Gradle multi-project with `implementation project(":domain")` declared only where legal.

---

## 7. C#

`NetArchTest.Rules` gives the same IL-level view as ArchUnit, asserted from xUnit. Full test class at `configs/HexagonalArchitectureTests.cs`.

```csharp
private static Types AppTypes =>
    Types.InAssembly(typeof(Domain.Model.Order).Assembly);   // anchored on a TYPE, not a string

[Fact]
public void Driving_adapters_enter_through_driving_ports()
{
    var result = AppTypes
        .That().ResideInNamespaceStartingWith(AdapterDriving)
        .ShouldNot().HaveDependencyOnAny(UseCase, PortDriven)
        .GetResult();

    AssertArchitecture(result, "A driving adapter enters through Application.Port.Driving only.");
}
```

Three things worth copying from the shipped file:

- **Anchor the assembly on a type** (`typeof(Domain.Model.Order).Assembly`), not on an assembly-name string. A rename then breaks the build instead of silently emptying every rule.
- **Surface `result.FailingTypeNames` in the assertion message.** NetArchTest's default failure is just `Assert.True(false)` — naming the offending types is what makes it actionable.
- **Adapter independence as a `[Theory]`** with one `InlineData` per adapter, so a failure says which adapter broke the rule.

Tier 2: one `.csproj` per layer with `ProjectReference` declared only where legal — idiomatic in .NET and compile-time. The xUnit rules then cover what project boundaries cannot express, chiefly the driving/driven split inside a single Application project.

---

## 8. Rust

Rust has no mainstream module-boundary linter and does not need one. **A crate per layer makes every boundary a compile error** — tier 2 by default, nothing to configure or bypass. Full layout and manifests at `configs/rust-workspace.md`.

The move that makes this stronger than any linter: split the two port sides into **separate crates**.

```
crates/
├── domain/                     [dependencies] is empty — that IS the enforcement
├── application-port-driving/   → domain
├── application-port-driven/    → domain
├── application-usecase/        → domain, both port crates
├── adapter-driving-web/        → domain, port-driving        (port-driven not in scope)
├── adapter-driven-persistence/ → domain, port-driven         (port-driving not in scope)
└── config/                     → everything
```

A driving adapter whose manifest lists only `application-port-driving` *cannot name* a driven port. On every other stack that rule needs a linter; here it is `error[E0432]: unresolved import`.

Use cases take ports as generic parameters, so the use-case crate never names an adapter:

```rust
pub struct PlaceOrder<R: OrderRepository, E: EventPublisher> { pub repo: R, pub events: E }
```

The one gap the crate graph cannot close is third-party crates — nothing stops someone adding `sqlx` to `crates/domain/Cargo.toml`. Close it with `cargo-deny`'s `wrappers` field, which permits a crate only for named consumers:

```toml
[[bans.deny]]
name = "sqlx"
wrappers = ["adapter-driven-persistence"]   # only this crate may depend on sqlx
```

Cost: ten crates for a small service is real overhead — ten manifests, slower cold builds. Take it when the architecture is load-bearing; otherwise use one crate with the same directory layout and accept that you have convention, not enforcement.

---

## 9. Wiring It Into an Agentic Loop

Enforcement only changes agent behavior if the agent can run it and read the result. Five requirements:

1. **One command, documented in `CLAUDE.md`.** `make arch` or `npm run arch`. If the check is only reachable through a 12-minute CI pipeline, the agent will not use it and will discover violations after the PR.
2. **Wire it into the same gate as tests.** `npm test` / `make check` should run the architecture check. A separate optional command is a command nobody runs.
3. **Error messages must name the rule and the fix.** dependency-cruiser's `comment`, import-linter's contract `name`, and depguard's `desc` all appear verbatim in output — write them as instructions to the next agent ("enter through `port/driving`"), not as labels.
4. **Verify the check can fail, before trusting it.** Every one of these tools has a misconfiguration that produces a green run with zero enforcement — dependency-cruiser without `typescript` installed cruises 0 modules and reports success; eslint-plugin-boundaries without an import resolver classifies everything "unknown" and fires nothing. Seed a deliberate violation (`import { PostgresOrderRepository } from "../../infrastructure/adapter/driven/persistence/PostgresOrderRepository"` inside a domain file), confirm the check goes red, then delete it. Do this at setup and again whenever the config changes. **A passing architecture check is worthless until you have seen it fail.**
5. **Ban the bypass in CI.** `# noqa`, `// eslint-disable-next-line boundaries/*`, and `depcruise --no-config` are all escape hatches. Grep for them in CI and fail. An unpoliced escape hatch converts tier 1 back into a README.

Pre-commit hook (fast, local, no network):

```yaml
# .pre-commit-config.yaml
- repo: local
  hooks:
    - id: arch
      name: architecture boundaries
      entry: lint-imports
      language: system
      pass_filenames: false
```

**Add the rule to the prompt as well as the linter.** State the dependency table from §1 in `CLAUDE.md` so the agent writes conforming code on the first attempt, and keep the linter so the second attempt cannot lie. Prompt without lint drifts; lint without prompt burns a correction round-trip on every feature.

---

## 10. Failure Modes to Watch For

| Smell | Why it defeats the boundary |
|---|---|
| Port named after its adapter (`PostgresOrderRepository` in `port/driven/`) | The dependency inverted on paper only; swapping the DB now touches the core |
| Controller imports `PlaceOrder` instead of `PlaceOrderUseCase` | Driving port becomes dead code; transport is welded to the implementation |
| ORM entity used as domain model | JPA/SQLAlchemy annotations *are* an outward dependency, and the layers contract cannot see them — this is why the external-package rule exists |
| DTO defined in an adapter, returned by a use case | The application's public signature now depends on an adapter type; the compiler enforces the inverse of your intent |
| Framework request/response objects in `application` | Same as above, and it makes the use case untestable without a web server |
| `driven/messaging` importing `driving/messaging` "to share the serializer" | Shared code between adapters belongs in neither — extract it, or duplicate it |
| Layer check green, but `ApplicationConfig` is 900 lines | The composition root may import everything; it may not *contain* logic. Nothing lints this — review it |
| Domain exceptions caught nowhere | Not a boundary violation, but the usual sign that adapters are reaching around the application layer |

---

## Quick Reference

Every config below was run against a working fixture in the layout from §1, clean and with seeded violations.

| Stack | Tier 1 config | Sees | Tier 2 (compile-time) |
|---|---|---|---|
| TypeScript | `dependency-cruiser.js` / `eslint.boundaries.mjs` | imports, npm packages, cycles | workspace packages + project references |
| Python | `.importlinter` | imports, PyPI packages, exhaustiveness | separate distributions per layer |
| Go | `golangci-arch.yml` (depguard) | imports | `internal/`; cycles are compile errors |
| Java/Kotlin | `HexagonalArchitectureTest.java` (ArchUnit) | **bytecode** — annotations, field types, signatures | Gradle multi-project |
| C# | `HexagonalArchitectureTests.cs` (NetArchTest) | **IL** — same as ArchUnit | one `.csproj` per layer |
| Rust | — none needed | — | `rust-workspace.md`: crate per layer, **violations do not compile** |

Strength ordering, if you get to choose: Rust's crate graph > ArchUnit/NetArchTest bytecode rules > import-based linters. The gap that matters is annotations — `@Entity` on a domain model is invisible to every import-based tool.

## Sources

- Alistair Cockburn — "Hexagonal Architecture" (2005)
- Jeffrey Palermo — "The Onion Architecture" (2008)
- Robert C. Martin — *Clean Architecture* (2017)
- Vaughn Vernon — *Implementing Domain-Driven Design* (2013), ch. 4
- Tom Hombergs — *Get Your Hands Dirty on Clean Architecture* (2019) — the ArchUnit enforcement chapter
