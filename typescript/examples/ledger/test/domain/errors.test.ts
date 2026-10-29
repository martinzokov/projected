import { describe, expect, it } from "vitest";
import { AccountAlreadyOpened, AccountNotEmpty, AccountNotOpen, CurrencyMismatch, InsufficientFunds, NotAccountHolder } from "../../src/domain/account/errors.js";
import { TransferIdInUse, TransferToSameAccount } from "../../src/domain/transfer/errors.js";

/** Callers read these: each refusal says what was wrong, with the facts to act on. */
describe("business errors", () => {
  it.each([
    [new AccountAlreadyOpened({ accountId: "a-1" }), "Account a-1 is already open, for another holder or currency", { accountId: "a-1" }],
    [new AccountNotOpen({ accountId: "a-1" }), "Account a-1 is not open", { accountId: "a-1" }],
    [new CurrencyMismatch({ accountId: "a-1", accountCurrency: "EUR", currency: "USD" }), "Account a-1 holds EUR, not USD", { accountCurrency: "EUR", currency: "USD" }],
    [new InsufficientFunds({ accountId: "a-1", available: 5, requested: 7 }), "Account a-1 has 5 available, 7 requested", { available: 5, requested: 7 }],
    [new NotAccountHolder({ accountId: "a-1" }), "Only the holder of account a-1 can pay from it", { accountId: "a-1" }],
    [new AccountNotEmpty({ accountId: "a-1", balance: 3, transfersInFlight: 1 }), "Account a-1 still has a balance of 3 and 1 transfers in flight", { balance: 3, transfersInFlight: 1 }],
    [new TransferToSameAccount({ accountId: "a-1" }), "A transfer from account a-1 cannot go to the same account", { accountId: "a-1" }],
    [new TransferIdInUse({ transferId: "t-1" }), "Transfer t-1 was requested with other details", { transferId: "t-1" }],
  ])("%s explains itself", (error, message, data) => {
    expect(error.message).toBe(message);
    expect(error).toMatchObject(data);
  });
});
