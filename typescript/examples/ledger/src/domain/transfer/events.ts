import { defineEvent, z } from "@projected/domain/event-sourced";
import { Amount, Currency } from "../money.js";

/**
 * Facts about a transfer between two accounts, in the past tense. A transfer is a process: each
 * event records a step taken, so that whatever stopped it halfway carries on from the last one.
 */

/** Why a transfer did not happen. */
export const TransferProblem = z.enum(["insufficient-funds", "not-account-holder", "currency-mismatch", "payer-account-not-open", "payee-account-not-open"]);
export type TransferProblem = z.infer<typeof TransferProblem>;

export const TransferRequested = defineEvent("TransferRequested", {
  schema: z.object({
    transferId: z.string(),
    from: z.string(),
    to: z.string(),
    amount: Amount,
    currency: Currency,
    requestedBy: z.string(),
    requestedAt: z.iso.datetime(),
  }),
});

/** The paying account has set the amount aside. */
export const TransferFundsHeld = defineEvent("TransferFundsHeld", { schema: z.object({ transferId: z.string() }) });

/** The receiving account has the transfer on its way in. */
export const TransferCredited = defineEvent("TransferCredited", { schema: z.object({ transferId: z.string() }) });

/** Booked on both accounts. */
export const TransferCompleted = defineEvent("TransferCompleted", { schema: z.object({ transferId: z.string() }) });

/** Refused before any money moved. */
export const TransferRejected = defineEvent("TransferRejected", { schema: z.object({ transferId: z.string(), reason: TransferProblem }) });

/** The receiving account could not take it; the paying account, `from`, gets its hold back. */
export const TransferFailed = defineEvent("TransferFailed", { schema: z.object({ transferId: z.string(), from: z.string(), reason: TransferProblem }) });
