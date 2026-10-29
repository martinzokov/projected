import { defineError, z } from "@projected/domain/event-sourced";

/** Business rules a request can break. Each is an outcome the caller can act on. */

export class TransferToSameAccount extends defineError("TransferToSameAccount", {
  schema: z.object({ accountId: z.string() }),
  message: ({ accountId }) => `A transfer from account ${accountId} cannot go to the same account`,
}) {}

export class TransferIdInUse extends defineError("TransferIdInUse", {
  schema: z.object({ transferId: z.string() }),
  message: ({ transferId }) => `Transfer ${transferId} was requested with other details`,
  description: "Requesting the same transfer again is accepted; reusing its id for another transfer is not.",
}) {}
