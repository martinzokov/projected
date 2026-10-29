import { describe, expect, it } from "vitest";
import { DependencyUnavailable, OPERATE, Result, type EventStore } from "@projected/application/event-sourced";
import { fc, principal } from "@projected/testing/event-sourced";
import { AccountBalance } from "../src/application/port/driving/account-balance.js";
import { CloseAccount } from "../src/application/port/driving/close-account.js";
import { MakeTransfer } from "../src/application/port/driving/make-transfer.js";
import { TransferStatus } from "../src/application/port/driving/transfer-status.js";
import { WithdrawMoney } from "../src/application/port/driving/withdraw-money.js";
import { alice, bob, staff, teller, testLedger } from "./ledger.js";

type Ledger = ReturnType<typeof testLedger>;

const balanceOf = async (ledger: Ledger, accountId: string) => (await ledger.app.execute(AccountBalance, { accountId }, { principal: staff })).unwrap().account;
const statusOf = async (ledger: Ledger, transferId: string) => (await ledger.app.execute(TransferStatus, { transferId }, { principal: staff })).unwrap().transfer;
const transfer = (ledger: Ledger, transferId: string, from: string, to: string, amount: number, who = alice, currency = "EUR") =>
  ledger.app.execute(MakeTransfer, { transferId, from, to, amount, currency }, { principal: who });

/** Alice's account with 100.00 EUR, and Bob's with nothing. */
async function aliceAndBob(options?: Parameters<typeof testLedger>[0]) {
  const ledger = testLedger(options);
  await ledger.account("alice-1", alice.id, 100_00);
  await ledger.account("bob-1", bob.id);
  return ledger;
}

describe("a transfer", () => {
  it("moves the money from one account to the other, booked on both", async () => {
    const ledger = await aliceAndBob();

    (await transfer(ledger, "t-1", "alice-1", "bob-1", 30_00)).unwrap();
    await ledger.settle();

    expect(await statusOf(ledger, "t-1")).toMatchObject({ status: "completed", reason: null });
    expect(await balanceOf(ledger, "alice-1")).toMatchObject({ balance: 70_00, available: 70_00 });
    expect(await balanceOf(ledger, "bob-1")).toMatchObject({ balance: 30_00, available: 30_00, incoming: 0 });
  });

  it("is pending until it has been carried out, with nothing moved yet", async () => {
    const ledger = await aliceAndBob();

    (await transfer(ledger, "t-1", "alice-1", "bob-1", 30_00)).unwrap();

    expect(await statusOf(ledger, "t-1")).toMatchObject({ status: "pending" });
    expect(await balanceOf(ledger, "alice-1")).toMatchObject({ balance: 100_00, available: 100_00 });
  });

  it("is rejected, moving nothing, when the money is not there", async () => {
    const ledger = await aliceAndBob();

    (await transfer(ledger, "t-1", "alice-1", "bob-1", 100_01)).unwrap();
    await ledger.settle();

    expect(await statusOf(ledger, "t-1")).toMatchObject({ status: "rejected", reason: "insufficient-funds" });
    expect(await balanceOf(ledger, "alice-1")).toMatchObject({ balance: 100_00, available: 100_00 });
    expect(await balanceOf(ledger, "bob-1")).toMatchObject({ balance: 0 });
  });

  it("is rejected when the caller does not hold the paying account", async () => {
    const ledger = await aliceAndBob();

    (await transfer(ledger, "t-1", "alice-1", "bob-1", 10_00, bob)).unwrap();
    await ledger.settle();

    expect(await statusOf(ledger, "t-1")).toMatchObject({ status: "rejected", reason: "not-account-holder" });
  });

  it("is rejected when the paying account is not open, or holds another currency", async () => {
    const ledger = await aliceAndBob();

    (await transfer(ledger, "t-1", "alice-9", "bob-1", 10_00)).unwrap();
    (await transfer(ledger, "t-2", "alice-1", "bob-1", 10_00, alice, "USD")).unwrap();
    await ledger.settle();

    expect(await statusOf(ledger, "t-1")).toMatchObject({ status: "rejected", reason: "payer-account-not-open" });
    expect(await statusOf(ledger, "t-2")).toMatchObject({ status: "rejected", reason: "currency-mismatch" });
  });

  it("fails, giving the held funds back, when the receiving account holds another currency", async () => {
    const ledger = await aliceAndBob();
    await ledger.account("bob-usd", bob.id, 0, "USD");

    (await transfer(ledger, "t-1", "alice-1", "bob-usd", 30_00)).unwrap();
    await ledger.settle();

    expect(await statusOf(ledger, "t-1")).toMatchObject({ status: "failed", reason: "currency-mismatch" });
    expect(await balanceOf(ledger, "alice-1")).toMatchObject({ balance: 100_00, available: 100_00 });
  });

  it("fails, giving the held funds back, when the receiving account cannot take it", async () => {
    const ledger = await aliceAndBob();
    (await ledger.app.execute(CloseAccount, { accountId: "bob-1" }, { principal: staff })).unwrap();

    (await transfer(ledger, "t-1", "alice-1", "bob-1", 30_00)).unwrap();
    await ledger.settle();

    expect(await statusOf(ledger, "t-1")).toMatchObject({ status: "failed", reason: "payee-account-not-open" });
    expect(await balanceOf(ledger, "alice-1")).toMatchObject({ balance: 100_00, available: 100_00 });
  });

  it("holds the funds while it is carried out, so they cannot be spent twice", async () => {
    const ledger = await aliceAndBob();
    (await transfer(ledger, "t-1", "alice-1", "bob-1", 80_00)).unwrap();
    (await transfer(ledger, "t-2", "alice-1", "bob-1", 80_00)).unwrap();

    await ledger.settle();
    const withdrawal = await ledger.app.execute(WithdrawMoney, { accountId: "alice-1", amount: 20_01, currency: "EUR", reference: "atm" }, { principal: teller });

    expect([(await statusOf(ledger, "t-1"))?.status, (await statusOf(ledger, "t-2"))?.status]).toEqual(["completed", "rejected"]);
    expect(withdrawal.isErr() && withdrawal.error._tag).toBe("InsufficientFunds");
  });

  it("pays once when the same request is sent again", async () => {
    const ledger = await aliceAndBob();

    (await transfer(ledger, "t-1", "alice-1", "bob-1", 30_00)).unwrap();
    (await transfer(ledger, "t-1", "alice-1", "bob-1", 30_00)).unwrap();
    await ledger.settle();

    expect(await balanceOf(ledger, "bob-1")).toMatchObject({ balance: 30_00 });
  });

  it("pays once though every step of every transfer is delivered again", async () => {
    const ledger = await aliceAndBob();
    (await transfer(ledger, "t-1", "alice-1", "bob-1", 30_00)).unwrap();
    (await transfer(ledger, "t-2", "alice-1", "bob-1", 99_00)).unwrap();
    await ledger.settle();

    const replayed = await ledger.app.operate("rebuild", { handler: "transfer-process" }, { principal: principal("ops", [OPERATE]) });
    await ledger.settle();

    expect(replayed.isOk()).toBe(true);
    expect(await balanceOf(ledger, "alice-1")).toMatchObject({ balance: 70_00, available: 70_00 });
    expect(await balanceOf(ledger, "bob-1")).toMatchObject({ balance: 30_00, incoming: 0 });
  });

  it("carries on where it stopped when the store fails halfway through a step, paying once", async () => {
    let failures = 0;
    /** Fails the first write of each transfer step after the account's part of it was written. */
    const flaky = (store: EventStore): EventStore => ({
      ...store,
      appendToStream: async (stream, events, options) => {
        const step = events[0]?.type;
        if (stream.startsWith("transfer-") && (step === "TransferFundsHeld" || step === "TransferCredited" || step === "TransferCompleted") && failures++ % 2 === 0) {
          return Result.err(new DependencyUnavailable({ dependency: "event store", message: "connection reset" }));
        }
        return store.appendToStream(stream, events, options);
      },
    });
    const ledger = await aliceAndBob({ wrap: flaky });

    (await transfer(ledger, "t-1", "alice-1", "bob-1", 30_00)).unwrap();
    for (let attempt = 0; attempt < 10 && (await statusOf(ledger, "t-1"))?.status === "pending"; attempt++) await ledger.app.catchUp();

    expect(failures).toBeGreaterThanOrEqual(3);
    expect(await statusOf(ledger, "t-1")).toMatchObject({ status: "completed" });
    expect(await balanceOf(ledger, "alice-1")).toMatchObject({ balance: 70_00, available: 70_00 });
    expect(await balanceOf(ledger, "bob-1")).toMatchObject({ balance: 30_00, incoming: 0 });
  });

  it("carries on where it stopped when the store fails while an account is written, paying once", async () => {
    const failed = new Set<string>();
    /** Fails each account step the first time it is written. */
    const flaky = (store: EventStore): EventStore => ({
      ...store,
      appendToStream: async (stream, events, options) => {
        const step = events[0]?.type ?? "";
        if (["FundsHeld", "IncomingTransferRecorded", "TransferSent", "TransferReceived"].includes(step) && !failed.has(step)) {
          failed.add(step);
          return Result.err(new DependencyUnavailable({ dependency: "event store", message: "connection reset" }));
        }
        return store.appendToStream(stream, events, options);
      },
    });
    const ledger = await aliceAndBob({ wrap: flaky });

    (await transfer(ledger, "t-1", "alice-1", "bob-1", 30_00)).unwrap();
    await ledger.settle();

    expect(failed.size).toBe(4);
    expect(await statusOf(ledger, "t-1")).toMatchObject({ status: "completed", reason: null });
    expect(await balanceOf(ledger, "alice-1")).toMatchObject({ balance: 70_00, available: 70_00 });
    expect(await balanceOf(ledger, "bob-1")).toMatchObject({ balance: 30_00, incoming: 0 });
  });
});

describe("the ledger as a whole", () => {
  const customers = [alice, bob, principal("auth0|carol")];
  const accountIds = customers.map((_, index) => `acc-${index}`);

  it("conserves money and never overdraws an account, whatever transfers are asked for", async () => {
    const transfers = fc.array(
      fc.record({ from: fc.nat({ max: 2 }), to: fc.nat({ max: 2 }), amount: fc.integer({ min: 1, max: 60_00 }) }),
      { maxLength: 12 },
    );
    await fc.assert(
      fc.asyncProperty(fc.array(fc.nat({ max: 100_00 }), { minLength: 3, maxLength: 3 }), transfers, async (opening, asked) => {
        const ledger = testLedger();
        for (const [index, holder] of customers.entries()) await ledger.account(accountIds[index] ?? "", holder.id, opening[index] ?? 0);

        await Promise.all(asked.map(({ from, to, amount }, index) => transfer(ledger, `t-${index}`, accountIds[from] ?? "", accountIds[to] ?? "", amount, customers[from])));
        await ledger.settle();

        const balances = await Promise.all(accountIds.map((accountId) => balanceOf(ledger, accountId)));
        const statuses = await Promise.all(asked.map((_, index) => statusOf(ledger, `t-${index}`)));
        expect(balances.reduce((sum, account) => sum + (account?.balance ?? 0), 0)).toBe(opening.reduce((sum, amount) => sum + amount, 0));
        expect(balances.every((account) => account !== null && account.available === account.balance && account.balance >= 0 && account.incoming === 0)).toBe(true);
        expect(statuses.every((status) => status === null || status.status === "completed" || status.status === "rejected")).toBe(true);
      }),
      { numRuns: 40 },
    );
  });
});
