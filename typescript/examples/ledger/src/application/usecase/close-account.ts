import type { AggregateRepository, CommandHandler } from "@projected/application/event-sourced";
import { close, type Account } from "../../domain/account/account.js";
import type { CloseAccount } from "../port/driving/close-account.js";

export const closeAccount =
  (deps: { accounts: AggregateRepository<typeof Account> }): CommandHandler<typeof CloseAccount> =>
  async (input, context) =>
    (await deps.accounts.execute(input.accountId, (state) => close(state, input), context)).map(({ events }) => ({ closed: events.length > 0 }));
