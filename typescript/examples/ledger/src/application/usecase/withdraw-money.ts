import type { AggregateRepository, CommandHandler } from "@projected/application/event-sourced";
import { available, withdraw, type Account } from "../../domain/account/account.js";
import type { WithdrawMoney } from "../port/driving/withdraw-money.js";

export const withdrawMoney =
  (deps: { accounts: AggregateRepository<typeof Account> }): CommandHandler<typeof WithdrawMoney> =>
  async (input, context) =>
    (await deps.accounts.execute(input.accountId, (state) => withdraw(state, input), context)).map(({ state }) => ({
      balance: state.balance,
      available: available(state),
    }));
