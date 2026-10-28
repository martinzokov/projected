import { describe, expect, it } from "vitest";
import { Panic, defineError, defineEvent, z } from "@projected/domain";
import { AccountClosed, AccountOverdrawn, MoneyDeposited, MoneyWithdrawn } from "./fixtures.js";

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

describe("compile-time guarantees", () => {
  it("requires error data to match the schema", () => {
    // @ts-expect-error — shortfall must be a number
    void new AccountOverdrawn({ accountId: "a-1", shortfall: "lots" });
  });
});
