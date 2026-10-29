import type { AggregateRepository, CommandHandler } from "@projected/application/event-sourced";
import { available, deposit, type Account } from "../../domain/account/account.js";
import type { DepositMoney } from "../port/driving/deposit-money.js";

export const depositMoney =
  (deps: { accounts: AggregateRepository<typeof Account> }): CommandHandler<typeof DepositMoney> =>
  async (input, context) =>
    (await deps.accounts.execute(input.accountId, (state) => deposit(state, input), context)).map(({ state }) => ({
      balance: state.balance,
      available: available(state),
    }));
