import { describe, expect, it } from "vitest";
import { AccountBalance } from "../src/application/port/driving/account-balance.js";
import { DepositMoney } from "../src/application/port/driving/deposit-money.js";
import { alice, teller, testLedger } from "./ledger.js";

describe("a busy account", () => {
  it("is snapshotted every 100 events, and its balance still counts every one", async () => {
    const { app, account, snapshots } = testLedger();
    await account("alice-1", alice.id);

    for (let i = 0; i < 120; i++) (await app.execute(DepositMoney, { accountId: "alice-1", amount: 1, currency: "EUR", reference: `coin ${i}` }, { principal: teller })).unwrap();
    const snapshot = (await snapshots.load("account-alice-1")).unwrap();
    const balance = (await app.execute(AccountBalance, { accountId: "alice-1" }, { principal: alice })).unwrap();

    expect(snapshot).toMatchObject({ version: 100, schemaVersion: 1, state: { balance: 99 } });
    expect(balance.account).toMatchObject({ balance: 120, available: 120 });
  });
});
