# ledger

A banking ledger built with [projected](../../../README.md), event-sourced: the pilot service that
puts the framework through what a bank needs. What it offers, stores and announces is in
[`docs/catalog.md`](docs/catalog.md), generated from the code by `projected docs`.

- **Accounts never go overdrawn.** An account's balance is the fold of its events; a withdrawal or
  an outgoing transfer is refused beyond what is *available*, the balance less the funds held for
  transfers in flight. Money is an integer count of minor units (cents), never a float.
- **Transfers are a process, safe to repeat at every step.** `make-transfer` records the request
  and answers at once; the `transfer-process` handler carries it out in the background:

  ```
  TransferRequested ── hold the funds on the paying account ──▶ TransferFundsHeld
         │ refused: not there, not the holder, wrong currency          │
         ▼                                                              ▼
  TransferRejected            note it as incoming on the receiving one ──▶ TransferCredited
                                     │ refused: closed, wrong currency          │
                                     ▼                                          ▼
                              TransferFailed ── give the hold back      book both ──▶ TransferCompleted
  ```

  Delivery is at-least-once, so nothing may happen twice. A step runs only while the transfer is
  at the step before it; holding funds and noting an incoming transfer change nothing when the
  account has them already; booking and releasing change nothing once they are gone — and they go
  only after the transfer has moved on. Accounts keep only the transfers in flight, so their state
  stays small however long they live. The tests replay every step of every transfer, and make the
  store fail halfway through steps, and nothing is paid twice.
- **Long-lived accounts load from snapshots**, every 100 events.
- **Callers sign in at the bank's identity provider** (`@projected/auth-jwt`): customers see and pay
  from their own accounts, staff (`accounts:manage`) open, close and see any, tellers
  (`cash:handle`) pay money in and out, operators hold `projected:operate`.

```sh
pnpm check                       # compile, test, and `projected check`
JWT_ISSUER=https://bank.eu.auth0.com/ JWT_AUDIENCE=https://api.bank.example \
  pnpm build && pnpm start       # in memory; DATABASE_URL=postgres://… for PostgreSQL
```

## Under load

`pnpm load` serves the ledger over real HTTP behind real JWT verification, opens 200 accounts,
fires 5 000 random transfers 50 at a time, waits until every one has been carried out, and fails
unless every invariant held: no money created or lost, no account overdrawn, nothing left in
flight, every transfer completed or rejected. `ACCOUNTS`, `TRANSFERS` and `CONCURRENCY` change the
shape; `DATABASE_URL` runs it against PostgreSQL, in a schema of its own. A small version runs with
the tests.

Measured in a cloud sandbox, with PostgreSQL in Docker on the same machine (about a millisecond per
round trip to the database):

| | `make-transfer` requests | p50 / p99 latency | transfers carried out |
|---|---|---|---|
| in memory | 440/s | 110 / 194 ms | 440/s |
| PostgreSQL | 189/s | 243 / 708 ms | 51/s end to end |

On PostgreSQL the ceiling is the event store's ordering lock: appends commit one at a time per
schema, so that positions become visible in order (see `docs/persistence.md`), and here that is
about 420 appends a second. A transfer takes eight. Next to the database, with sub-millisecond round
trips, the same lock allows several times more; beyond that, the roadmap's in-flight tracking
replaces the lock. When requests outpace the process, as the load test makes them, holds pile up
and more transfers are refused for want of available funds — the rule working, not a fault.
