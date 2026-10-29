import { describe, expect, it } from "vitest";
import { everyHistoryFolds, given } from "@projected/testing/event-sourced";
import { TransferIdInUse, TransferToSameAccount } from "../../src/domain/transfer/errors.js";
import { TransferCompleted, TransferCredited, TransferFailed, TransferFundsHeld, TransferRejected, TransferRequested } from "../../src/domain/transfer/events.js";
import { Transfer, complete, fail, recordCredited, recordFundsHeld, reject, request } from "../../src/domain/transfer/transfer.js";

const transferId = "t-1";
const details = { transferId, from: "acc-1", to: "acc-2", amount: 30_00, currency: "EUR", requestedBy: "alice", requestedAt: "2024-03-01T09:00:00.000Z" };
const requested = TransferRequested(details);
const fundsHeld = TransferFundsHeld({ transferId });
const credited = TransferCredited({ transferId });

describe("transfer", () => {
  it("folds any history of transfer events", () => {
    everyHistoryFolds(Transfer);
  });
});

describe("requesting a transfer", () => {
  it("records the request", () => {
    given(Transfer).when((state) => request(state, details)).thenEvents(requested);
  });

  it("treats the same request again as done, whenever it arrives", () => {
    given(Transfer, [requested]).when((state) => request(state, { ...details, requestedAt: "2024-03-01T09:05:00.000Z" })).thenNothingHappens();
  });

  it.each([{ from: "acc-9" }, { to: "acc-9" }, { amount: 31_00 }, { currency: "USD" }, { requestedBy: "bob" }])("refuses the id for a transfer with %o", (other) => {
    given(Transfer, [requested]).when((state) => request(state, { ...details, ...other })).thenRejectsWith(TransferIdInUse, { transferId });
  });

  it("refuses a transfer to the paying account itself", () => {
    given(Transfer).when((state) => request(state, { ...details, to: "acc-1" })).thenRejectsWith(TransferToSameAccount, { accountId: "acc-1" });
  });
});

describe("the history of a transfer", () => {
  it("ignores steps of a transfer never requested, so that no store can make one up", () => {
    const steps = [TransferFundsHeld({ transferId }), TransferRejected({ transferId, reason: "insufficient-funds" }), TransferFailed({ transferId, from: "acc-1", reason: "currency-mismatch" })];

    expect(Transfer.fold(steps)).toEqual({ status: "unknown" });
  });

  it("keeps why it was refused", () => {
    expect(Transfer.fold([requested, TransferRejected({ transferId, reason: "not-account-holder" })])).toMatchObject({ status: "rejected", reason: "not-account-holder" });
    expect(Transfer.fold([requested, fundsHeld, TransferFailed({ transferId, from: "acc-1", reason: "currency-mismatch" })])).toMatchObject({
      status: "failed",
      reason: "currency-mismatch",
      from: "acc-1",
    });
  });
});

describe("the steps of a transfer", () => {
  it("go requested, held, credited, completed", () => {
    given(Transfer, [requested]).when((state) => recordFundsHeld(state, { transferId })).thenEvents(fundsHeld);
    given(Transfer, [requested, fundsHeld]).when((state) => recordCredited(state, { transferId })).thenEvents(credited);
    given(Transfer, [requested, fundsHeld, credited]).when((state) => complete(state, { transferId })).thenEvents(TransferCompleted({ transferId }));
  });

  it("each happen once, so the process may repeat any of them", () => {
    given(Transfer, [requested, fundsHeld]).when((state) => recordFundsHeld(state, { transferId })).thenNothingHappens();
    given(Transfer, [requested, fundsHeld, credited]).when((state) => recordCredited(state, { transferId })).thenNothingHappens();
    given(Transfer, [requested, fundsHeld, credited, TransferCompleted({ transferId })]).when((state) => complete(state, { transferId })).thenNothingHappens();
  });

  it("are never skipped", () => {
    given(Transfer, [requested]).when((state) => recordCredited(state, { transferId })).thenNothingHappens();
    given(Transfer, [requested]).when((state) => complete(state, { transferId })).thenNothingHappens();
    given(Transfer).when((state) => recordFundsHeld(state, { transferId })).thenNothingHappens();
  });

  it("end in a rejection only before funds are held", () => {
    given(Transfer, [requested]).when((state) => reject(state, { transferId, reason: "insufficient-funds" })).thenEvents(TransferRejected({ transferId, reason: "insufficient-funds" }));
    given(Transfer, [requested, fundsHeld]).when((state) => reject(state, { transferId, reason: "insufficient-funds" })).thenNothingHappens();
  });

  it("end in a failure only while funds are held", () => {
    given(Transfer, [requested, fundsHeld]).when((state) => fail(state, { transferId, reason: "payee-account-not-open" })).thenEvents(
      TransferFailed({ transferId, from: "acc-1", reason: "payee-account-not-open" }),
    );
    given(Transfer, [requested]).when((state) => fail(state, { transferId, reason: "payee-account-not-open" })).thenNothingHappens();
    given(Transfer, [requested, fundsHeld, credited]).when((state) => fail(state, { transferId, reason: "payee-account-not-open" })).thenNothingHappens();
  });
});
