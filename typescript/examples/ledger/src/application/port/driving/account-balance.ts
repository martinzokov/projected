import { defineQuery, z } from "@projected/application/event-sourced";
import { Id } from "./schemas.js";

/** An account the caller may not see answers as one that does not exist. */
export const AccountBalance = defineQuery({
  type: "account-balance",
  summary: "An account's balance and what is available to spend",
  input: z.object({ accountId: Id }),
  output: z.object({
    account: z
      .object({
        accountId: z.string(),
        holder: z.string(),
        currency: z.string(),
        status: z.enum(["open", "closed"]),
        balance: z.number().int().describe("Booked money, in minor units"),
        available: z.number().int().describe("The balance less outgoing transfers in flight"),
        incoming: z.number().int().describe("Incoming transfers not yet booked"),
      })
      .nullable(),
  }),
});
