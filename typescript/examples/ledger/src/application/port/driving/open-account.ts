import { defineCommand, z } from "@projected/application/event-sourced";
import { AccountAlreadyOpened } from "../../../domain/account/errors.js";
import { Currency } from "../../../domain/money.js";
import { Id, MANAGE_ACCOUNTS } from "./schemas.js";

export const OpenAccount = defineCommand({
  type: "open-account",
  summary: "Open an account for a customer, in one currency",
  description: "Opening the same account again, for the same holder and currency, is accepted and changes nothing.",
  access: { permissions: [MANAGE_ACCOUNTS] },
  input: z.object({ accountId: Id, holder: z.string().min(1).describe("The customer's user id at the identity provider"), currency: Currency }),
  output: z.object({ accountId: z.string() }),
  errors: [AccountAlreadyOpened],
});
