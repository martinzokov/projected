import { defineCommand, z } from "@projected/application/event-sourced";
import { AccountNotOpen, CurrencyMismatch, InsufficientFunds } from "../../../domain/account/errors.js";
import { Amount, Currency } from "../../../domain/money.js";
import { HANDLE_CASH, Id } from "./schemas.js";

export const WithdrawMoney = defineCommand({
  type: "withdraw-money",
  summary: "Pay money out of an account, never beyond what is available",
  description: "Send an Idempotency-Key: a withdrawal retried with the same key is booked once.",
  access: { permissions: [HANDLE_CASH] },
  input: z.object({ accountId: Id, amount: Amount.describe("In the currency's minor unit"), currency: Currency, reference: z.string().min(1).max(140) }),
  output: z.object({ balance: z.number().int(), available: z.number().int() }),
  errors: [AccountNotOpen, CurrencyMismatch, InsufficientFunds],
});
