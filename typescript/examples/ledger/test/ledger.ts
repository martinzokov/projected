import type { EventStore } from "@projected/application/event-sourced";
import { httpHandler } from "@projected/http";
import { inMemoryCheckpointStore, inMemoryDocumentStore, inMemoryEventStore, inMemoryIdempotencyStore, inMemorySnapshotStore } from "@projected/store-memory/event-sourced";
import { fixedClock, principal, sequentialIds, tokenAuthenticator } from "@projected/testing/event-sourced";
import { DepositMoney } from "../src/application/port/driving/deposit-money.js";
import { OpenAccount } from "../src/application/port/driving/open-account.js";
import { HANDLE_CASH, MANAGE_ACCOUNTS } from "../src/application/port/driving/schemas.js";
import { composeLedger } from "../src/infrastructure/config/ledger.js";

/** Who calls the ledger in tests: two customers, a member of staff and a teller. */
export const alice = principal("auth0|alice");
export const bob = principal("auth0|bob");
export const staff = principal("auth0|staff", [MANAGE_ACCOUNTS]);
export const teller = principal("teller-1", [HANDLE_CASH], "service");
const tokens = { alice, bob, staff, teller };

/**
 * The real composition, with deterministic time and ids and in-memory stores, served by the real
 * HTTP handler. `wrap` stands between the ledger and its event store, to make it fail.
 */
export function testLedger(options: { wrap?: (store: EventStore) => EventStore } = {}) {
  const clock = fixedClock("2024-03-01T09:00:00.000Z");
  const defects: Error[] = [];
  const store = inMemoryEventStore({ clock, ids: sequentialIds("event") });
  const eventStore = options.wrap?.(store) ?? store;
  const snapshots = inMemorySnapshotStore();
  const app = composeLedger({
    eventStore,
    snapshots,
    checkpoints: inMemoryCheckpointStore(),
    documents: inMemoryDocumentStore(),
    idempotency: inMemoryIdempotencyStore({ clock }),
    clock,
    ids: sequentialIds("id"),
    onDefect: (defect) => defects.push(defect),
  });
  const handler = httpHandler(app, {
    messageIds: sequentialIds("request").next,
    authenticator: tokenAuthenticator(Object.fromEntries(Object.entries(tokens).map(([token, who]) => [`${token}-token`, who]))),
  });
  /** POST as `who`, with any extra headers. */
  const post = async (path: string, body: unknown, who: keyof typeof tokens | "nobody" = "alice", headers: Record<string, string> = {}) => {
    const response = await handler(
      new Request(`http://ledger.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(who === "nobody" ? {} : { authorization: `Bearer ${who}-token` }), ...headers },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  /**
   * Run the background event handlers until there is nothing left to do: every transfer settles.
   * A catch-up that fails — transfers meeting on one account ran out of retries — is run again,
   * as the poller would.
   */
  const settle = async () => {
    let outcome = await app.catchUp();
    for (let round = 0; round < 1000; round++, outcome = await app.catchUp()) {
      if (outcome.isOk() && outcome.value.every((report) => report.handled === 0)) return;
    }
    throw new Error(`the ledger did not settle: ${outcome.isErr() ? outcome.error.message : "still busy"}`);
  };
  /** An open account holding `balance`. */
  const account = async (accountId: string, holder: string, balance = 0, currency = "EUR") => {
    (await app.execute(OpenAccount, { accountId, holder, currency }, { principal: staff })).unwrap();
    if (balance > 0) (await app.execute(DepositMoney, { accountId, amount: balance, currency, reference: "opening deposit" }, { principal: teller })).unwrap();
  };
  return { app, handler, post, settle, account, clock, defects, store, snapshots };
}
