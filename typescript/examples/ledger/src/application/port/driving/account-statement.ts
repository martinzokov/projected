import { defineQuery, z } from "@projected/application/event-sourced";
import { Id } from "./schemas.js";

export const StatementEntry = z.object({
  entry: z.number().int().describe("The entry's place in the account's history"),
  kind: z.enum(["deposit", "withdrawal", "transfer-sent", "transfer-received"]),
  amount: z.number().int().describe("Signed: money in is positive, money out negative"),
  reference: z.string().describe("The deposit's or withdrawal's reference, or the transfer id"),
  counterparty: z.string().nullable().describe("The account on the other side of a transfer"),
  bookedAt: z.iso.datetime(),
});

/** What was booked on an account in one month. An account the caller may not see has no entries. */
export const AccountStatement = defineQuery({
  type: "account-statement",
  summary: "The money booked in and out of an account in one month",
  input: z.object({ accountId: Id, month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM") }),
  output: z.object({ entries: z.array(StatementEntry) }),
});
