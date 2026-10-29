import { defineQuery, z } from "@projected/application/event-sourced";
import { TransferProblem } from "../../../domain/transfer/events.js";
import { Id } from "./schemas.js";

/** A transfer the caller did not request answers as one that does not exist. */
export const TransferStatus = defineQuery({
  type: "transfer-status",
  summary: "Where a transfer has got to",
  input: z.object({ transferId: Id }),
  output: z.object({
    transfer: z
      .object({
        transferId: z.string(),
        from: z.string(),
        to: z.string(),
        amount: z.number().int(),
        currency: z.string(),
        requestedAt: z.iso.datetime(),
        status: z.enum(["pending", "completed", "rejected", "failed"]),
        reason: TransferProblem.nullable(),
      })
      .nullable(),
  }),
});
