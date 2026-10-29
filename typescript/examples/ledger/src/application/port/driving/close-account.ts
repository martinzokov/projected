import { defineCommand, z } from "@projected/application/event-sourced";
import { AccountNotEmpty, AccountNotOpen } from "../../../domain/account/errors.js";
import { Id, MANAGE_ACCOUNTS } from "./schemas.js";

export const CloseAccount = defineCommand({
  type: "close-account",
  summary: "Close an account with nothing left in it",
  access: { permissions: [MANAGE_ACCOUNTS] },
  input: z.object({ accountId: Id }),
  output: z.object({ closed: z.boolean().describe("False when it was already closed") }),
  errors: [AccountNotOpen, AccountNotEmpty],
});
