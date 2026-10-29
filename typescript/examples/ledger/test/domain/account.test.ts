import { describe, expect, it } from "vitest";
import { everyHistoryFolds, given } from "@projected/testing/event-sourced";
import { Account, close, deposit, holdFunds, open, receiveIncoming, recordIncoming, releaseHold, sendHeld, withdraw } from "../../src/domain/account/account.js";
import { AccountAlreadyOpened, AccountNotEmpty, AccountNotOpen, CurrencyMismatch, InsufficientFunds, NotAccountHolder } from "../../src/domain/account/errors.js";
import {
  AccountClosed,
  AccountOpened,
  FundsHeld,
  HoldReleased,
  IncomingTransferRecorded,
  MoneyDeposited,
  MoneyWithdrawn,
  TransferReceived,
  TransferSent,
} from "../../src/domain/account/events.js";

const accountId = "acc-1";
const opened = AccountOpened({ accountId, holder: "alice", currency: "EUR" });
const funded = [opened, MoneyDeposited({ accountId, amount: 100_00, reference: "salary" })];
const cash = { accountId, currency: "EUR", reference: "atm" };
const hold = { accountId, transferId: "t-1", amount: 30_00, currency: "EUR", payee: "acc-2", requestedBy: "alice" };
const held = FundsHeld({ accountId, transferId: "t-1", amount: 30_00, payee: "acc-2" });
const incoming = { accountId, transferId: "t-9", amount: 5_00, currency: "EUR", payer: "acc-3" };

describe("account", () => {
  it("folds any history of account events, and a snapshot of any state restores it", () => {
    everyHistoryFolds(Account);
  });
});

describe("an account never opened", () => {
  it("has no holder, no currency and nothing in it", () => {
    expect(Account.fold([])).toEqual({ status: "unknown", holder: "", currency: "", balance: 0, held: {}, incoming: {} });
  });
});

describe("opening an account", () => {
  it("opens it for a holder, in one currency", () => {
    given(Account).when((state) => open(state, { accountId, holder: "alice", currency: "EUR" })).thenEvents(opened);
  });

  it("treats opening it again for the same holder and currency as done", () => {
    given(Account, [opened]).when((state) => open(state, { accountId, holder: "alice", currency: "EUR" })).thenNothingHappens();
  });

  it("refuses an id already in use for another holder or currency, or by a closed account", () => {
    given(Account, [opened]).when((state) => open(state, { accountId, holder: "bob", currency: "EUR" })).thenRejectsWith(AccountAlreadyOpened, { accountId });
    given(Account, [opened]).when((state) => open(state, { accountId, holder: "alice", currency: "USD" })).thenRejectsWith(AccountAlreadyOpened);
    given(Account, [opened, AccountClosed({ accountId })]).when((state) => open(state, { accountId, holder: "alice", currency: "EUR" })).thenRejectsWith(AccountAlreadyOpened);
  });
});

describe("paying money in and out", () => {
  it("books a deposit", () => {
    given(Account, [opened]).when((state) => deposit(state, { ...cash, amount: 25_00 })).thenEvents(MoneyDeposited({ accountId, amount: 25_00, reference: "atm" }));
  });

  it("books a withdrawal of everything that is available", () => {
    given(Account, funded).when((state) => withdraw(state, { ...cash, amount: 100_00 })).thenEvents(MoneyWithdrawn({ accountId, amount: 100_00, reference: "atm" }));
  });

  it("takes withdrawals off the balance", () => {
    expect(Account.fold([...funded, MoneyWithdrawn({ accountId, amount: 40_00, reference: "atm" })]).balance).toBe(60_00);
  });

  it("never lets an account go overdrawn", () => {
    given(Account, funded)
      .when((state) => withdraw(state, { ...cash, amount: 100_01 }))
      .thenRejectsWith(InsufficientFunds, { accountId, available: 100_00, requested: 100_01 });
  });

  it("counts held funds as spent", () => {
    given(Account, [...funded, held])
      .when((state) => withdraw(state, { ...cash, amount: 70_01 }))
      .thenRejectsWith(InsufficientFunds, { available: 70_00, requested: 70_01 });
  });

  it("takes money only in the account's currency", () => {
    given(Account, funded)
      .when((state) => deposit(state, { ...cash, amount: 1, currency: "USD" }))
      .thenRejectsWith(CurrencyMismatch, { accountId, accountCurrency: "EUR", currency: "USD" });
    given(Account, funded).when((state) => withdraw(state, { ...cash, amount: 1, currency: "USD" })).thenRejectsWith(CurrencyMismatch);
  });

  it("moves no money on an account that is not open", () => {
    given(Account).when((state) => deposit(state, { ...cash, amount: 1 })).thenRejectsWith(AccountNotOpen, { accountId });
    given(Account, [opened, AccountClosed({ accountId })]).when((state) => withdraw(state, { ...cash, amount: 1 })).thenRejectsWith(AccountNotOpen);
  });
});

describe("closing an account", () => {
  it("closes an empty account", () => {
    given(Account, [opened]).when((state) => close(state, { accountId })).thenEvents(AccountClosed({ accountId }));
  });

  it("treats closing it twice as done", () => {
    given(Account, [opened, AccountClosed({ accountId })]).when((state) => close(state, { accountId })).thenNothingHappens();
  });

  it("refuses while money or a transfer is still in it", () => {
    given(Account, funded).when((state) => close(state, { accountId })).thenRejectsWith(AccountNotEmpty, { accountId, balance: 100_00, transfersInFlight: 0 });
    given(Account, [opened, IncomingTransferRecorded({ accountId, transferId: "t-9", amount: 5_00, payer: "acc-3" })])
      .when((state) => close(state, { accountId }))
      .thenRejectsWith(AccountNotEmpty, { balance: 0, transfersInFlight: 1 });
  });

  it("cannot close an account never opened", () => {
    given(Account).when((state) => close(state, { accountId })).thenRejectsWith(AccountNotOpen);
  });
});

describe("an outgoing transfer", () => {
  it("holds the funds when the holder asks and they are available", () => {
    given(Account, funded).when((state) => holdFunds(state, hold)).thenEvents(held);
  });

  it("can hold everything that is available", () => {
    given(Account, funded).when((state) => holdFunds(state, { ...hold, amount: 100_00 })).thenEvents(FundsHeld({ accountId, transferId: "t-1", amount: 100_00, payee: "acc-2" }));
  });

  it("holds them once, however often the step is repeated", () => {
    given(Account, [...funded, held]).when((state) => holdFunds(state, hold)).thenNothingHappens();
  });

  it("is refused for anyone but the holder", () => {
    given(Account, funded).when((state) => holdFunds(state, { ...hold, requestedBy: "mallory" })).thenRejectsWith(NotAccountHolder, { accountId });
  });

  it("is refused beyond what is available, other holds deducted", () => {
    given(Account, [...funded, held])
      .when((state) => holdFunds(state, { ...hold, transferId: "t-2", amount: 70_01 }))
      .thenRejectsWith(InsufficientFunds, { available: 70_00, requested: 70_01 });
  });

  it("is refused in another currency, or from an account that is not open", () => {
    given(Account, funded).when((state) => holdFunds(state, { ...hold, currency: "GBP" })).thenRejectsWith(CurrencyMismatch);
    given(Account).when((state) => holdFunds(state, hold)).thenRejectsWith(AccountNotOpen);
  });

  it("books the held amount out, once", () => {
    given(Account, [...funded, held]).when((state) => sendHeld(state, { accountId, transferId: "t-1" })).thenEvents(
      TransferSent({ accountId, transferId: "t-1", amount: 30_00, payee: "acc-2" }),
    );
    given(Account, [...funded, held, TransferSent({ accountId, transferId: "t-1", amount: 30_00, payee: "acc-2" })])
      .when((state) => sendHeld(state, { accountId, transferId: "t-1" }))
      .thenNothingHappens();
  });

  it("gives the hold back, once", () => {
    given(Account, [...funded, held]).when((state) => releaseHold(state, { accountId, transferId: "t-1" })).thenEvents(HoldReleased({ accountId, transferId: "t-1", amount: 30_00 }));
    given(Account, [...funded, held, HoldReleased({ accountId, transferId: "t-1", amount: 30_00 })])
      .when((state) => releaseHold(state, { accountId, transferId: "t-1" }))
      .thenNothingHappens();
  });

  it("knows only its own transfers, whatever their ids", () => {
    given(Account, funded).when((state) => sendHeld(state, { accountId, transferId: "constructor" })).thenNothingHappens();
    given(Account, funded).when((state) => holdFunds(state, { ...hold, transferId: "constructor" })).thenEvents(FundsHeld({ accountId, transferId: "constructor", amount: 30_00, payee: "acc-2" }));
  });
});

describe("an incoming transfer", () => {
  const recorded = IncomingTransferRecorded({ accountId, transferId: "t-9", amount: 5_00, payer: "acc-3" });

  it("is noted on an open account in its currency, once", () => {
    given(Account, [opened]).when((state) => recordIncoming(state, incoming)).thenEvents(recorded);
    given(Account, [opened, recorded]).when((state) => recordIncoming(state, incoming)).thenNothingHappens();
  });

  it("is refused by an account that is not open, or holds another currency", () => {
    given(Account, [opened, AccountClosed({ accountId })]).when((state) => recordIncoming(state, incoming)).thenRejectsWith(AccountNotOpen);
    given(Account, [opened]).when((state) => recordIncoming(state, { ...incoming, currency: "USD" })).thenRejectsWith(CurrencyMismatch);
  });

  it("is booked in, once", () => {
    given(Account, [opened, recorded]).when((state) => receiveIncoming(state, { accountId, transferId: "t-9" })).thenEvents(
      TransferReceived({ accountId, transferId: "t-9", amount: 5_00, payer: "acc-3" }),
    );
    given(Account, [opened, recorded, TransferReceived({ accountId, transferId: "t-9", amount: 5_00, payer: "acc-3" })])
      .when((state) => receiveIncoming(state, { accountId, transferId: "t-9" }))
      .thenNothingHappens();
  });
});
