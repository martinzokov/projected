import { defineError, defineEvent, migration, z } from "@projected/domain";

/** A tiny banking domain shared by the kernel tests. Definitions only: nothing here is mutable. */

export class AccountOverdrawn extends defineError("AccountOverdrawn", {
  schema: z.object({ accountId: z.string(), shortfall: z.number() }),
  message: ({ accountId, shortfall }) => `Account ${accountId} is short by ${shortfall}`,
}) {}

export class AccountClosed extends defineError("AccountClosed", { message: "The account is closed" }) {}

export const MoneyDeposited = defineEvent("MoneyDeposited", { schema: z.object({ amount: z.number() }) });
export const MoneyWithdrawn = defineEvent("MoneyWithdrawn", {
  version: 2,
  schema: z.object({ amount: z.number(), reason: z.string() }),
  migrations: [migration(1, z.object({ amount: z.number() }), (v1) => ({ ...v1, reason: "unknown" }))],
});
