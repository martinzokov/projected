import { defineError, z } from "@projected/domain/event-sourced";

/** Business rules a request can break. Each is an outcome the caller can act on. */

export class AccountAlreadyOpened extends defineError("AccountAlreadyOpened", {
  schema: z.object({ accountId: z.string() }),
  message: ({ accountId }) => `Account ${accountId} is already open, for another holder or currency`,
  description: "An account with this id exists. Opening it again with the same holder and currency is accepted.",
}) {}

export class AccountNotOpen extends defineError("AccountNotOpen", {
  schema: z.object({ accountId: z.string() }),
  message: ({ accountId }) => `Account ${accountId} is not open`,
  description: "The account was never opened, or has been closed.",
}) {}

export class CurrencyMismatch extends defineError("CurrencyMismatch", {
  schema: z.object({ accountId: z.string(), accountCurrency: z.string(), currency: z.string() }),
  message: ({ accountId, accountCurrency, currency }) => `Account ${accountId} holds ${accountCurrency}, not ${currency}`,
}) {}

export class InsufficientFunds extends defineError("InsufficientFunds", {
  schema: z.object({ accountId: z.string(), available: z.number().int(), requested: z.number().int() }),
  message: ({ accountId, available, requested }) => `Account ${accountId} has ${available} available, ${requested} requested`,
  description: "Accounts never go overdrawn: the amount exceeds what is available, holds deducted.",
}) {}

export class NotAccountHolder extends defineError("NotAccountHolder", {
  schema: z.object({ accountId: z.string() }),
  message: ({ accountId }) => `Only the holder of account ${accountId} can pay from it`,
}) {}

export class AccountNotEmpty extends defineError("AccountNotEmpty", {
  schema: z.object({ accountId: z.string(), balance: z.number().int(), transfersInFlight: z.number().int() }),
  message: ({ accountId, balance, transfersInFlight }) =>
    `Account ${accountId} still has a balance of ${balance} and ${transfersInFlight} transfers in flight`,
  description: "Only an account with a zero balance and no transfer in flight can be closed.",
}) {}
