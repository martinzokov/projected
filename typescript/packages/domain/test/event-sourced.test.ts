import { describe, expect, expectTypeOf, it } from "vitest";
import { Result, defineAggregate, type Decision, type EventOf } from "@projected/domain/event-sourced";
import { AccountClosed, AccountOverdrawn, MoneyDeposited, MoneyWithdrawn } from "./fixtures.js";

type AccountState = { readonly balance: number; readonly open: boolean };
const initialState = (): AccountState => ({ balance: 0, open: true });

const Account = defineAggregate({
  name: "account",
  initialState,
  events: [MoneyDeposited, MoneyWithdrawn],
  evolve: {
    MoneyDeposited: (state, { amount }) => ({ ...state, balance: state.balance + amount }),
    MoneyWithdrawn: (state, { amount }) => ({ ...state, balance: state.balance - amount }),
  },
});

const withdraw = (
  state: AccountState,
  input: { accountId: string; amount: number },
): Decision<typeof Account, AccountOverdrawn | AccountClosed> => {
  if (!state.open) return Result.err(new AccountClosed());
  if (state.balance < input.amount) {
    return Result.err(new AccountOverdrawn({ accountId: input.accountId, shortfall: input.amount - state.balance }));
  }
  return Result.ok([MoneyWithdrawn({ amount: input.amount, reason: "atm" })]);
};

describe("defineAggregate", () => {
  it("folds events into state", () => {
    const state = Account.fold([MoneyDeposited({ amount: 10 }), MoneyWithdrawn({ amount: 4, reason: "atm" })]);

    expect(state).toEqual({ balance: 6, open: true });
  });

  it("names streams by category and id", () => {
    expect(Account.streamName("a-1")).toBe("account-a-1");
  });

  it("encodes at the current version and decodes through the definitions", () => {
    const encoded = Account.encode(MoneyWithdrawn({ amount: 1, reason: "x" }));

    expect(encoded.schemaVersion).toBe(2);
    expect(Account.decode(encoded).unwrap()).toEqual({ type: "MoneyWithdrawn", data: { amount: 1, reason: "x" } });
  });

  it("does not decode events the aggregate does not own", () => {
    expect(Account.decode({ type: "Unrelated", schemaVersion: 1, data: {} }).isErr()).toBe(true);
  });

  it("supports decision functions returning typed errors", () => {
    const rejected = withdraw(Account.fold([MoneyDeposited({ amount: 2 })]), { accountId: "a-1", amount: 5 });

    expect(rejected.isErr() && rejected.error.message).toBe("Account a-1 is short by 3");
  });

  it("rejects names that would break stream naming", () => {
    expect(() =>
      defineAggregate({ name: "bank-account", initialState: () => 0, events: [], evolve: {} }),
    ).toThrow(/camelCase/);
  });
});

describe("compile-time guarantees", () => {
  it("infers event unions and decision types", () => {
    expectTypeOf<EventOf<typeof Account>["type"]>().toEqualTypeOf<"MoneyDeposited" | "MoneyWithdrawn">();
    expectTypeOf(withdraw).returns.toEqualTypeOf<
      Decision<typeof Account, AccountOverdrawn | AccountClosed>
    >();
  });

  it("requires an evolve handler for every event", () => {
    expect(() =>
      defineAggregate({
        name: "incomplete",
        initialState,
        events: [MoneyDeposited, MoneyWithdrawn],
        // @ts-expect-error — MoneyWithdrawn has no handler
        evolve: { MoneyDeposited: (state) => state },
      }),
    ).toThrow(/no evolve handler for MoneyWithdrawn/);
  });
});
