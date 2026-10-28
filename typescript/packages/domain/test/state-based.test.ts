import { describe, expect, expectTypeOf, it } from "vitest";
import {
  Panic,
  Result,
  changeTo,
  defineAggregate,
  defineEvent,
  migration,
  noChange,
  remove,
  z,
  type Decision,
  type EventOf,
  type StateOf,
} from "@projected/domain/state-based";
import { AccountClosed, AccountOverdrawn, MoneyDeposited, MoneyWithdrawn } from "./fixtures.js";

const Account = defineAggregate({
  name: "account",
  schema: z.object({ balance: z.number(), open: z.boolean() }),
  events: [MoneyDeposited, MoneyWithdrawn],
});
type AccountState = StateOf<typeof Account>;

const withdraw = (
  state: AccountState | undefined,
  input: { accountId: string; amount: number },
): Decision<typeof Account, AccountOverdrawn | AccountClosed> => {
  if (state === undefined || !state.open) return Result.err(new AccountClosed());
  if (state.balance < input.amount) {
    return Result.err(new AccountOverdrawn({ accountId: input.accountId, shortfall: input.amount - state.balance }));
  }
  return Result.ok(changeTo({ ...state, balance: state.balance - input.amount }, MoneyWithdrawn({ amount: input.amount, reason: "atm" })));
};

describe("defineAggregate", () => {
  it("names storage keys by category and id", () => {
    expect(Account.key("a-1")).toBe("account-a-1");
  });

  it("encodes state at the current version and validates it on decode", () => {
    const encoded = Account.encode({ balance: 5, open: true });

    expect(encoded).toEqual({ schemaVersion: 1, data: { balance: 5, open: true } });
    expect(Account.decode(encoded).unwrap()).toEqual({ balance: 5, open: true });
    expect(Account.decode({ schemaVersion: 1, data: { balance: "lots" } }).isErr()).toBe(true);
  });

  it("refuses to encode a state its schema rejects, as a defect", () => {
    const Named = defineAggregate({ name: "named", schema: z.object({ name: z.string().min(1) }) });

    expect(() => Named.encode({ name: "" })).toThrow(Panic);
  });

  it("migrates older stored states on decode", () => {
    const Versioned = defineAggregate({
      name: "versioned",
      version: 2,
      schema: z.object({ name: z.string(), tags: z.array(z.string()) }),
      migrations: [migration(1, z.object({ name: z.string() }), (v1) => ({ ...v1, tags: [] }))],
    });

    expect(Versioned.decode({ schemaVersion: 1, data: { name: "x" } }).unwrap()).toEqual({ name: "x", tags: [] });
    expect(Versioned.decode({ schemaVersion: 3, data: {} }).isErr()).toBe(true);
  });

  it("requires one migration per older version", () => {
    expect(() => defineAggregate({ name: "broken", version: 2, schema: z.object({}) })).toThrow(/needs one migration/);
  });

  it("encodes the events it lists, and refuses others", () => {
    expect(Account.encodeEvent(MoneyDeposited({ amount: 1 }))).toEqual({ type: "MoneyDeposited", schemaVersion: 1, data: { amount: 1 } });
    expect(() => Account.encodeEvent({ type: "Unrelated", data: {} } as never)).toThrow(Panic);
  });

  it("supports decisions that change, remove or keep the state", () => {
    const changed = withdraw({ balance: 10, open: true }, { accountId: "a-1", amount: 4 });
    const rejected = withdraw({ balance: 2, open: true }, { accountId: "a-1", amount: 5 });

    expect(changed.unwrap()).toEqual({
      kind: "change",
      state: { balance: 6, open: true },
      events: [{ type: "MoneyWithdrawn", data: { amount: 4, reason: "atm" } }],
    });
    expect(rejected.isErr() && rejected.error.message).toBe("Account a-1 is short by 3");
    expect(remove(MoneyDeposited({ amount: 0 }))).toEqual({ kind: "remove", events: [{ type: "MoneyDeposited", data: { amount: 0 } }] });
    expect(noChange()).toEqual({ kind: "none" });
  });

  it("rejects names that would break storage keys", () => {
    expect(() => defineAggregate({ name: "bank-account", schema: z.object({}) })).toThrow(/camelCase/);
  });
});

describe("compile-time guarantees", () => {
  it("infers event unions and decision types", () => {
    expectTypeOf<EventOf<typeof Account>["type"]>().toEqualTypeOf<"MoneyDeposited" | "MoneyWithdrawn">();
    expectTypeOf<AccountState>().toEqualTypeOf<{ balance: number; open: boolean }>();
  });

  it("requires decisions to produce a valid state", () => {
    const invalid = (): Decision<typeof Account> =>
      // @ts-expect-error — `open` is missing from the new state
      Result.ok(changeTo({ balance: 1 }));
    void invalid;
  });

  it("allows decisions to emit only the aggregate's events", () => {
    const Unlisted = defineEvent("AccountAudited", { schema: z.object({}) });
    const invalid = (): Decision<typeof Account> =>
      // @ts-expect-error — AccountAudited is not one of Account's events
      Result.ok(changeTo({ balance: 1, open: true }, Unlisted({})));
    void invalid;
  });
});
