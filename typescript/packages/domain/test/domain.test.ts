import { describe, expect, expectTypeOf, it } from "vitest";
import {
  Panic,
  Result,
  defineAggregate,
  defineError,
  defineEvent,
  migration,
  z,
  type Decision,
  type EventOf,
} from "@projected/domain";

class AccountOverdrawn extends defineError("AccountOverdrawn", {
  schema: z.object({ accountId: z.string(), shortfall: z.number() }),
  message: ({ accountId, shortfall }) => `Account ${accountId} is short by ${shortfall}`,
}) {}

class AccountClosed extends defineError("AccountClosed", { message: "The account is closed" }) {}

const MoneyDeposited = defineEvent("MoneyDeposited", { schema: z.object({ amount: z.number() }) });
const MoneyWithdrawn = defineEvent("MoneyWithdrawn", {
  version: 2,
  schema: z.object({ amount: z.number(), reason: z.string() }),
  migrations: [migration(1, z.object({ amount: z.number() }), (v1) => ({ ...v1, reason: "unknown" }))],
});

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

describe("defineError", () => {
  it("builds tagged errors with typed data and a derived message", () => {
    const error = new AccountOverdrawn({ accountId: "a-1", shortfall: 5 });

    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe("AccountOverdrawn");
    expect(error.message).toBe("Account a-1 is short by 5");
    expect(error.shortfall).toBe(5);
    expect(AccountOverdrawn.is(error)).toBe(true);
    expect(AccountClosed.is(error)).toBe(false);
    expect(AccountOverdrawn.tag).toBe("AccountOverdrawn");
  });

  it("allows errors without data to be constructed without arguments", () => {
    expect(new AccountClosed().message).toBe("The account is closed");
  });

  it("rejects tags that are not PascalCase", () => {
    expect(() => defineError("account-closed")).toThrow(Panic);
  });

  it("rejects schemas that shadow Error properties", () => {
    expect(() => defineError("Bad", { schema: z.object({ message: z.string() }) })).toThrow(/reserved/);
  });
});

describe("defineEvent", () => {
  it("creates plain event values", () => {
    expect(MoneyDeposited({ amount: 10 })).toEqual({ type: "MoneyDeposited", data: { amount: 10 } });
  });

  it("migrates older stored versions on decode", () => {
    const decoded = MoneyWithdrawn.decode({ type: "MoneyWithdrawn", schemaVersion: 1, data: { amount: 3 } });

    expect(decoded.unwrap()).toEqual({ type: "MoneyWithdrawn", data: { amount: 3, reason: "unknown" } });
  });

  it("refuses stored data that does not match the schema", () => {
    const decoded = MoneyDeposited.decode({ type: "MoneyDeposited", schemaVersion: 1, data: { amount: "ten" } });

    expect(decoded.isErr() && decoded.error._tag).toBe("EventDecodingFailed");
  });

  it("refuses versions newer than the definition knows", () => {
    const decoded = MoneyDeposited.decode({ type: "MoneyDeposited", schemaVersion: 2, data: { amount: 1 } });

    expect(decoded.isErr()).toBe(true);
  });

  it("requires one migration per older version", () => {
    expect(() => defineEvent("Thing", { version: 2, schema: z.object({}) })).toThrow(/needs 1 migration/);
  });
});

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

  it("requires error data to match the schema", () => {
    // @ts-expect-error — shortfall must be a number
    void new AccountOverdrawn({ accountId: "a-1", shortfall: "lots" });
  });
});
