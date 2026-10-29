import { defineCommand, z } from "@projected/application/event-sourced";
import { Amount, Currency } from "../../../domain/money.js";
import { TransferIdInUse, TransferToSameAccount } from "../../../domain/transfer/errors.js";
import { Id } from "./schemas.js";

export const MakeTransfer = defineCommand({
  type: "make-transfer",
  summary: "Ask to move money from one of your accounts to another account",
  description:
    "The transfer is accepted at once and carried out in the background: follow it with transfer-status. " +
    "The caller must hold the paying account. The transfer id is the caller's, so a retry never pays twice.",
  input: z.object({ transferId: Id, from: Id, to: Id, amount: Amount.describe("In the currency's minor unit"), currency: Currency }),
  output: z.object({ transferId: z.string() }),
  errors: [TransferToSameAccount, TransferIdInUse],
});
