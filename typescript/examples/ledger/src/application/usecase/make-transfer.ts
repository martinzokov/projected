import type { AggregateRepository, Clock, CommandHandler } from "@projected/application/event-sourced";
import { request, type Transfer } from "../../domain/transfer/transfer.js";
import type { MakeTransfer } from "../port/driving/make-transfer.js";
import { caller } from "./access.js";

/** Records the request; the transfer process moves the money. */
export const makeTransfer =
  (deps: { transfers: AggregateRepository<typeof Transfer>; clock: Clock }): CommandHandler<typeof MakeTransfer> =>
  async (input, context) => {
    const details = { ...input, requestedBy: caller(context).id, requestedAt: deps.clock.now().toISOString() };
    return (await deps.transfers.execute(input.transferId, (state) => request(state, details), context)).map(() => ({ transferId: input.transferId }));
  };
