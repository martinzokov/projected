import type { AggregateRepository, QueryHandler } from "@projected/application/event-sourced";
import type { Transfer } from "../../domain/transfer/transfer.js";
import type { TransferStatus } from "../port/driving/transfer-status.js";
import { caller } from "./access.js";
import { MANAGE_ACCOUNTS } from "../port/driving/schemas.js";

export const transferStatus =
  (deps: { transfers: AggregateRepository<typeof Transfer> }): QueryHandler<typeof TransferStatus> =>
  async ({ transferId }, context) =>
    (await deps.transfers.load(transferId)).map(({ state }) => {
      const principal = caller(context);
      if (state.status === "unknown" || (state.requestedBy !== principal.id && !principal.permissions.includes(MANAGE_ACCOUNTS))) return { transfer: null };
      const settled = state.status === "completed" || state.status === "rejected" || state.status === "failed";
      return {
        transfer: {
          transferId,
          from: state.from,
          to: state.to,
          amount: state.amount,
          currency: state.currency,
          requestedAt: state.requestedAt,
          status: settled ? state.status : "pending",
          reason: state.status === "rejected" || state.status === "failed" ? state.reason : null,
        },
      };
    });
