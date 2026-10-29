import { defineEvent, z } from "@projected/domain/event-sourced";
import { Amount, Currency } from "../money.js";

/**
 * Facts about an account, in the past tense. Persisted forever: never change a published schema.
 *
 * Money moves in two steps when it is a transfer: funds are held on the paying account and
 * recorded as incoming on the receiving one, then both are booked. Deposits and withdrawals are
 * booked at once.
 */

export const AccountOpened = defineEvent("AccountOpened", {
  schema: z.object({ accountId: z.string(), holder: z.string(), currency: Currency }),
});

export const MoneyDeposited = defineEvent("MoneyDeposited", {
  schema: z.object({ accountId: z.string(), amount: Amount, reference: z.string() }),
});

export const MoneyWithdrawn = defineEvent("MoneyWithdrawn", {
  schema: z.object({ accountId: z.string(), amount: Amount, reference: z.string() }),
});

/** Set aside for an outgoing transfer: no longer available, not yet booked. */
export const FundsHeld = defineEvent("FundsHeld", {
  schema: z.object({ accountId: z.string(), transferId: z.string(), amount: Amount, payee: z.string() }),
});

/** A hold given back, because the transfer could not be completed. */
export const HoldReleased = defineEvent("HoldReleased", {
  schema: z.object({ accountId: z.string(), transferId: z.string(), amount: Amount }),
});

/** A held amount booked out of the account: the transfer's debit. */
export const TransferSent = defineEvent("TransferSent", {
  schema: z.object({ accountId: z.string(), transferId: z.string(), amount: Amount, payee: z.string() }),
});

/** A transfer on its way in: known, not yet available. */
export const IncomingTransferRecorded = defineEvent("IncomingTransferRecorded", {
  schema: z.object({ accountId: z.string(), transferId: z.string(), amount: Amount, payer: z.string() }),
});

/** An incoming transfer booked into the account: the transfer's credit. */
export const TransferReceived = defineEvent("TransferReceived", {
  schema: z.object({ accountId: z.string(), transferId: z.string(), amount: Amount, payer: z.string() }),
});

export const AccountClosed = defineEvent("AccountClosed", {
  schema: z.object({ accountId: z.string() }),
});
