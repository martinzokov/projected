import { Result, type AggregateRepository, type QueryHandler } from "@projected/application/event-sourced";
import type { Account } from "../../domain/account/account.js";
import type { AccountStatement } from "../port/driving/account-statement.js";
import type { Statements } from "../port/driven/statements.js";
import { caller, maySee } from "./access.js";

export const accountStatement =
  (deps: { accounts: AggregateRepository<typeof Account>; statements: Statements }): QueryHandler<typeof AccountStatement> =>
  async ({ accountId, month }, context) =>
    Result.gen(async function* () {
      const { state } = yield* Result.await(deps.accounts.load(accountId));
      // An account never opened has no holder, so only staff get this far — to find no entries.
      if (!maySee(caller(context), state.holder)) return Result.ok({ entries: [] });
      const entries = yield* Result.await(deps.statements.inMonth(accountId, month));
      return Result.ok({
        entries: entries.map(({ entry, kind, amount, reference, counterparty, bookedAt }) => ({ entry, kind, amount, reference, counterparty, bookedAt })),
      });
    });
