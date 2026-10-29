import { z, type DocumentStore } from "@projected/application/event-sourced";
import type { Statements } from "../../../../application/port/driven/statements.js";

const Entry = z.object({
  accountId: z.string(),
  entry: z.number().int(),
  month: z.string(),
  kind: z.enum(["deposit", "withdrawal", "transfer-sent", "transfer-received"]),
  amount: z.number().int(),
  reference: z.string(),
  counterparty: z.string().nullable(),
  bookedAt: z.iso.datetime(),
});

/** The {@link Statements} read model on any {@link DocumentStore}: one document per booking. */
export function documentStatements(documents: DocumentStore): Statements {
  const entries = documents.collection("statement-entries", Entry);
  return {
    record: (entry) => entries.put(`${entry.accountId}:${entry.entry}`, { ...entry, month: entry.bookedAt.slice(0, 7) }),
    inMonth: async (accountId, month) =>
      (await entries.find({ accountId, month }, { orderBy: "entry" })).map((found) =>
        found.map(({ month: _month, ...entry }) => entry),
      ),
  };
}
