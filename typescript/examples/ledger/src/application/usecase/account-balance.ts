import type { AggregateRepository, QueryHandler } from "@projected/application/event-sourced";
import { available, type Account } from "../../domain/account/account.js";
import type { AccountBalance } from "../port/driving/account-balance.js";
import { caller, maySee } from "./access.js";

/** Answers from the account itself, so a balance is never behind the last command. Snapshots keep it cheap. */
export const accountBalance =
  (deps: { accounts: AggregateRepository<typeof Account> }): QueryHandler<typeof AccountBalance> =>
  async ({ accountId }, context) =>
    (await deps.accounts.load(accountId)).map(({ state }) => ({
      account:
        state.status === "unknown" || !maySee(caller(context), state.holder)
          ? null
          : {
              accountId,
              holder: state.holder,
              currency: state.currency,
              status: state.status,
              balance: state.balance,
              available: available(state),
              incoming: Object.values(state.incoming).reduce((sum, { amount }) => sum + amount, 0),
            },
    }));
