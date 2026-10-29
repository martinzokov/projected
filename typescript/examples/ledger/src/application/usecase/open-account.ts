import type { AggregateRepository, CommandHandler } from "@projected/application/event-sourced";
import { open, type Account } from "../../domain/account/account.js";
import type { OpenAccount } from "../port/driving/open-account.js";

export const openAccount =
  (deps: { accounts: AggregateRepository<typeof Account> }): CommandHandler<typeof OpenAccount> =>
  async (input, context) =>
    (await deps.accounts.execute(input.accountId, (state) => open(state, input), context)).map(() => ({ accountId: input.accountId }));
