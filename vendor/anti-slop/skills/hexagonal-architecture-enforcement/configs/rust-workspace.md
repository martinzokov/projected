# Rust — enforcement by crate graph

Verified against cargo 1.97.1 (Rust 2021 edition), 10-crate workspace.

Rust has no mainstream module-boundary linter, and it does not need one. A crate
per layer makes every boundary a **compile error** — tier 2 enforcement with no
rule file, no plugin, and nothing to bypass. This is strictly stronger than what
the linters on other stacks achieve, and it is the idiomatic Rust answer.

## Layout

```
Cargo.toml                      [workspace] members = ["crates/*"]
crates/
├── domain/                     no dependencies at all
├── application-port-driving/   → domain
├── application-port-driven/    → domain
├── application-usecase/        → domain, both port crates
├── adapter-driving-web/        → domain, port-driving
├── adapter-driving-messaging/  → domain, port-driving
├── adapter-driven-persistence/ → domain, port-driven
├── adapter-driven-payment/     → domain, port-driven
├── adapter-driven-messaging/   → domain, port-driven
└── config/                     → everything (composition root)
```

Splitting the two port sides into **separate crates** is what buys the
driving/driven rule at compile time. A driving adapter that lists only
`application-port-driving` in its manifest cannot name a driven port — the crate
is not in scope. On every other stack that rule needs a linter.

## Manifests

```toml
# crates/domain/Cargo.toml
[package]
name = "domain"
version = "0.1.0"
edition = "2021"

# The enforcement IS this empty table. The domain crate cannot name any other
# crate in the workspace, so an inward-pointing import is a compile error.
[dependencies]
```

```toml
# crates/adapter-driving-web/Cargo.toml
[package]
name = "adapter-driving-web"
version = "0.1.0"
edition = "2021"

# Note what is absent: application-port-driven and application-usecase.
# A driving adapter physically cannot reach them.
[dependencies]
domain = { path = "../domain" }
application-port-driving = { path = "../application-port-driving" }
```

```toml
# crates/adapter-driven-persistence/Cargo.toml
[dependencies]
domain = { path = "../domain" }
application-port-driven = { path = "../application-port-driven" }
```

```toml
# crates/config/Cargo.toml — the ONE crate allowed to depend on everything
[dependencies]
domain = { path = "../domain" }
application-usecase = { path = "../application-usecase" }
adapter-driving-web = { path = "../adapter-driving-web" }
adapter-driven-persistence = { path = "../adapter-driven-persistence" }
adapter-driven-messaging = { path = "../adapter-driven-messaging" }
```

Use cases take ports as generic parameters, so the use-case crate never names an
adapter:

```rust
pub struct PlaceOrder<R: OrderRepository, E: EventPublisher> { pub repo: R, pub events: E }
```

## What a violation looks like

Each of these was introduced into the working fixture and produced a compile
error, not a warning:

| Violation | Result |
|---|---|
| `domain` uses `adapter_driven_persistence` | ``error[E0432]: unresolved import `adapter_driven_persistence` `` |
| driving adapter uses `application_port_driven` | ``error[E0432]: unresolved import `application_port_driven` `` |
| driven adapter uses `application_usecase` | ``error[E0432]: unresolved import `application_usecase` `` |
| adapter uses a sibling adapter | ``error[E0432]: unresolved import `adapter_driven_persistence` `` |

`cargo build --workspace` fails. There is no `#[allow]` for this — the crate is
simply not in scope.

## The two gaps, and what closes them

**Third-party crates in the domain.** The crate graph stops workspace crates, not
`sqlx` appearing in `crates/domain/Cargo.toml`. Nothing prevents someone adding
it. Close this with `cargo-deny`:

```toml
# deny.toml
[bans]
multiple-versions = "allow"

[[bans.deny]]
name = "sqlx"
wrappers = ["adapter-driven-persistence"]   # only this crate may depend on sqlx

[[bans.deny]]
name = "axum"
wrappers = ["adapter-driving-web"]
```

`wrappers` is the key field: the crate is banned everywhere *except* the listed
consumers, which is exactly "only the persistence adapter may see the database
driver". Run `cargo deny check bans` in CI.

**Boundaries inside one crate.** If a layer grows internal structure you want
policed (`domain::model` vs `domain::service`), the crate graph cannot see it —
that is what `pub(crate)` and module privacy are for, and they are weaker. If
this matters, split further into crates rather than reaching for a linter.

## Cost

Ten crates for a small application is real overhead: ten manifests, slower cold
builds, and `cargo add` needs the right `-p`. Take it when the architecture is
load-bearing. For a smaller service, a single crate with `pub(crate)` module
discipline and the same directory layout is a reasonable compromise — you lose
compile-time enforcement and get nothing back but convention, so make that
trade deliberately rather than by default.
