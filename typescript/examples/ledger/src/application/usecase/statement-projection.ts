import { defineEventHandler } from "@projected/application/event-sourced";
import { MoneyDeposited, MoneyWithdrawn, TransferReceived, TransferSent } from "../../domain/account/events.js";
import type { Statements } from "../port/driven/statements.js";

const accountOf = (stream: string) => stream.slice("account-".length);

/**
 * Keeps each account's statement: one entry per booking. Holds and incoming transfers are not
 * bookings, so they never appear. Idempotent: an entry is keyed by the version that booked it.
 */
export const statementProjection = (deps: { statements: Statements }) =>
  defineEventHandler({
    name: "statements",
    events: [MoneyDeposited, MoneyWithdrawn, TransferSent, TransferReceived],
    handle: {
      MoneyDeposited: ({ stream, streamVersion, recordedAt, data }) =>
        deps.statements.record({ accountId: accountOf(stream), entry: streamVersion, kind: "deposit", amount: data.amount, reference: data.reference, counterparty: null, bookedAt: recordedAt }),
      MoneyWithdrawn: ({ stream, streamVersion, recordedAt, data }) =>
        deps.statements.record({ accountId: accountOf(stream), entry: streamVersion, kind: "withdrawal", amount: -data.amount, reference: data.reference, counterparty: null, bookedAt: recordedAt }),
      TransferSent: ({ stream, streamVersion, recordedAt, data }) =>
        deps.statements.record({ accountId: accountOf(stream), entry: streamVersion, kind: "transfer-sent", amount: -data.amount, reference: data.transferId, counterparty: data.payee, bookedAt: recordedAt }),
      TransferReceived: ({ stream, streamVersion, recordedAt, data }) =>
        deps.statements.record({ accountId: accountOf(stream), entry: streamVersion, kind: "transfer-received", amount: data.amount, reference: data.transferId, counterparty: data.payer, bookedAt: recordedAt }),
    },
  });
