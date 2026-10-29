import { describe, expect, it } from "vitest";
import { Account } from "../src/domain/account/account.js";
import { IncomingTransferRecorded } from "../src/domain/account/events.js";
import { alice, testLedger } from "./ledger.js";

const deposit = { accountId: "alice-1", amount: 50_00, currency: "EUR", reference: "cash" };

describe("ledger over HTTP", () => {
  it("serves its OpenAPI document", async () => {
    const { handler } = testLedger();

    const response = await handler(new Request("http://ledger.test/openapi.json"));

    expect(response.status).toBe(200);
  });

  it("lets staff open accounts, and no one else", async () => {
    const { post } = testLedger();
    const account = { accountId: "alice-1", holder: alice.id, currency: "EUR" };

    const byCustomer = await post("/commands/open-account/version/1", account, "alice");
    const byStaff = await post("/commands/open-account/version/1", account, "staff");
    const anonymous = await post("/commands/open-account/version/1", account, "nobody");

    expect([byCustomer.status, byStaff.status, anonymous.status]).toEqual([403, 200, 401]);
  });

  it("books a deposit retried with the same idempotency key once", async () => {
    const { post, account } = testLedger();
    await account("alice-1", alice.id);

    const first = await post("/commands/deposit-money/version/1", deposit, "teller", { "idempotency-key": "deposit-0001" });
    const retry = await post("/commands/deposit-money/version/1", deposit, "teller", { "idempotency-key": "deposit-0001" });

    expect([first.body["value"], retry.body["value"]]).toEqual([{ balance: 50_00, available: 50_00 }, { balance: 50_00, available: 50_00 }]);
  });

  it("answers a withdrawal beyond what is available with the business error", async () => {
    const { post, account } = testLedger();
    await account("alice-1", alice.id, 10_00);

    const refused = await post("/commands/withdraw-money/version/1", { ...deposit, amount: 10_01 }, "teller");

    expect(refused.body).toMatchObject({ status: "error", error: { type: "InsufficientFunds", data: { accountId: "alice-1", available: 10_00, requested: 10_01 } } });
  });

  it("pays money out, booked on the statement", async () => {
    const { post, account, settle } = testLedger();
    await account("alice-1", alice.id, 10_00);

    const withdrawn = await post("/commands/withdraw-money/version/1", { ...deposit, amount: 4_00, reference: "atm 12" }, "teller");
    await settle();
    const statement = await post("/queries/account-statement/version/1", { accountId: "alice-1", month: "2024-03" });

    expect(withdrawn.body["value"]).toEqual({ balance: 6_00, available: 6_00 });
    expect(statement.body["value"]).toMatchObject({ entries: [{ kind: "deposit" }, { entry: 3, kind: "withdrawal", amount: -4_00, reference: "atm 12", counterparty: null }] });
  });

  it("closes an empty account, once", async () => {
    const { post, account } = testLedger();
    await account("alice-1", alice.id);

    const first = await post("/commands/close-account/version/1", { accountId: "alice-1" }, "staff");
    const again = await post("/commands/close-account/version/1", { accountId: "alice-1" }, "staff");

    expect([first.body["value"], again.body["value"]]).toEqual([{ closed: true }, { closed: false }]);
  });

  it("takes only ISO 4217 currency codes", async () => {
    const { post } = testLedger();

    const answers = await Promise.all(["EURO", "XEUR", "eur"].map((currency) => post("/commands/open-account/version/1", { accountId: "a-1", holder: alice.id, currency }, "staff")));

    expect(answers.map(({ status }) => status)).toEqual([400, 400, 400]);
    expect(JSON.stringify(answers[0]?.body)).toContain("an ISO 4217 code, such as EUR");
  });

  it("answers for an account never opened with nothing, even to staff", async () => {
    const { post } = testLedger();

    const answer = await post("/queries/account-balance/version/1", { accountId: "nobody-1" }, "staff");

    expect(answer.body["value"]).toEqual({ account: null });
  });

  it("shows incoming transfers apart from the balance until they are booked", async () => {
    const { post, account, store } = testLedger();
    await account("alice-1", alice.id, 10_00);
    const incoming = [12_00, 3_00].map((amount, index) => Account.encode(IncomingTransferRecorded({ accountId: "alice-1", transferId: `t-${index}`, amount, payer: "bob-1" })));
    (await store.appendToStream("account-alice-1", incoming, { expectedVersion: "any" })).unwrap();

    const answer = await post("/queries/account-balance/version/1", { accountId: "alice-1" });

    expect(answer.body["value"]).toMatchObject({ account: { balance: 10_00, available: 10_00, incoming: 15_00 } });
  });

  it("shows an account to its holder and to staff, and to no one else", async () => {
    const { post, account } = testLedger();
    await account("alice-1", alice.id, 10_00);

    const seen = await Promise.all(["alice", "staff", "bob"].map((who) => post("/queries/account-balance/version/1", { accountId: "alice-1" }, who as "alice")));

    expect(seen.map(({ body }) => (body["value"] as { account: { balance: number } | null }).account?.balance ?? null)).toEqual([10_00, 10_00, null]);
  });

  it("carries a transfer out, followed through its status and both statements", async () => {
    const { post, account, settle } = testLedger();
    await account("alice-1", alice.id, 100_00);
    await account("bob-1", "auth0|bob");

    const made = await post("/commands/make-transfer/version/1", { transferId: "rent-2024-03", from: "alice-1", to: "bob-1", amount: 30_00, currency: "EUR" });
    await settle();
    const status = await post("/queries/transfer-status/version/1", { transferId: "rent-2024-03" });
    const hidden = await post("/queries/transfer-status/version/1", { transferId: "rent-2024-03" }, "bob");
    const paid = await post("/queries/account-statement/version/1", { accountId: "alice-1", month: "2024-03" });
    const received = await post("/queries/account-statement/version/1", { accountId: "bob-1", month: "2024-03" }, "bob");

    expect(made).toEqual({ status: 200, body: { status: "ok", value: { transferId: "rent-2024-03" } } });
    expect(status.body["value"]).toMatchObject({ transfer: { status: "completed", amount: 30_00, requestedAt: "2024-03-01T09:00:00.000Z" } });
    expect(hidden.body["value"]).toEqual({ transfer: null });
    expect(paid.body["value"]).toEqual({ entries: [
      { entry: 2, kind: "deposit", amount: 100_00, reference: "opening deposit", counterparty: null, bookedAt: "2024-03-01T09:00:00.000Z" },
      { entry: 4, kind: "transfer-sent", amount: -30_00, reference: "rent-2024-03", counterparty: "bob-1", bookedAt: "2024-03-01T09:00:00.000Z" },
    ] });
    expect(received.body["value"]).toMatchObject({ entries: [{ kind: "transfer-received", amount: 30_00, counterparty: "alice-1" }] });
  });

  it("keeps a statement to its account's holder and to staff", async () => {
    const { post, account, settle } = testLedger();
    await account("alice-1", alice.id, 10_00);
    await settle();

    const bobs = await post("/queries/account-statement/version/1", { accountId: "alice-1", month: "2024-03" }, "bob");
    const staffs = await post("/queries/account-statement/version/1", { accountId: "alice-1", month: "2024-03" }, "staff");

    const entries = (body: Record<string, unknown>) => (body["value"] as { entries: unknown[] }).entries.length;
    expect([entries(bobs.body), entries(staffs.body)]).toEqual([0, 1]);
  });

  it("refuses a transfer to the paying account itself", async () => {
    const { post } = testLedger();

    const refused = await post("/commands/make-transfer/version/1", { transferId: "t-1", from: "alice-1", to: "alice-1", amount: 1, currency: "EUR" });

    expect(refused.body).toMatchObject({ status: "error", error: { type: "TransferToSameAccount", data: { accountId: "alice-1" } } });
  });
});
