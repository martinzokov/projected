import { Result, defineEventHandler, isInfrastructureError, type AggregateRepository, type InfrastructureError } from "@projected/application/event-sourced";
import { holdFunds, receiveIncoming, recordIncoming, releaseHold, sendHeld, type Account } from "../../domain/account/account.js";
import type { AccountNotOpen, CurrencyMismatch, InsufficientFunds, NotAccountHolder } from "../../domain/account/errors.js";
import { TransferCredited, TransferFailed, TransferFundsHeld, TransferRequested, type TransferProblem } from "../../domain/transfer/events.js";
import { complete, fail, recordCredited, recordFundsHeld, reject, type Transfer, type TransferState } from "../../domain/transfer/transfer.js";

/** A transfer that was requested, at whichever step. */
type Requested = Exclude<TransferState, { readonly status: "unknown" }>;

const NOT_OPEN = { payer: "payer-account-not-open", payee: "payee-account-not-open" } as const;

/** Why an account refused its part, as the transfer records it. */
const problem = (refusal: AccountNotOpen | CurrencyMismatch | NotAccountHolder | InsufficientFunds, side: "payer" | "payee"): TransferProblem => {
  switch (refusal._tag) {
    case "InsufficientFunds":
      return "insufficient-funds";
    case "NotAccountHolder":
      return "not-account-holder";
    case "CurrencyMismatch":
      return "currency-mismatch";
    case "AccountNotOpen":
      return NOT_OPEN[side];
  }
};

/**
 * Carries each transfer out, one step per transfer event: hold the funds on the paying account,
 * note the transfer on the receiving one, then book both — or reject the transfer, or give the
 * hold back. A saga step: it writes an account and then the transfer, and is allowed to (see
 * projected.json).
 *
 * Delivery is at-least-once, so every step is safe to repeat. A step runs only while the
 * transfer is at the step before it. Holding funds and noting an incoming transfer change
 * nothing when the account already has them; booking and releasing change nothing once they
 * are gone — and they go only after the transfer has moved past the step that put them there.
 */
export const transferProcess = (deps: { accounts: AggregateRepository<typeof Account>; transfers: AggregateRepository<typeof Transfer> }) => {
  /** The transfer, if it is at `status`; otherwise this step was taken already. */
  const at = async <S extends Requested["status"]>(transferId: string, status: S): Promise<Result<(Requested & { readonly status: S }) | undefined, InfrastructureError>> =>
    (await deps.transfers.load(transferId)).map(({ state }) => (state.status === status ? (state as Requested & { readonly status: S }) : undefined));

  return defineEventHandler({
    name: "transfer-process",
    events: [TransferRequested, TransferFundsHeld, TransferCredited, TransferFailed],
    // Each transfer's steps are in its own stream, so transfers proceed side by side, each in
    // order. Two that meet on one account are kept apart by its version, and retried.
    concurrency: 16,
    handle: {
      TransferRequested: ({ data }, context) =>
        Result.gen(async function* () {
          const { transferId, from, to, amount, currency, requestedBy } = data;
          if ((yield* Result.await(at(transferId, "requested"))) === undefined) return Result.ok(undefined);
          const held = await deps.accounts.execute(from, (account) => holdFunds(account, { accountId: from, transferId, amount, currency, payee: to, requestedBy }), context);
          const refusal = held.isErr() ? held.error : undefined;
          if (isInfrastructureError(refusal)) return Result.err(refusal);
          yield* Result.await(
            deps.transfers.execute(
              transferId,
              (state) => (refusal === undefined ? recordFundsHeld(state, { transferId }) : reject(state, { transferId, reason: problem(refusal, "payer") })),
              context,
            ),
          );
          return Result.ok(undefined);
        }),

      TransferFundsHeld: ({ data: { transferId } }, context) =>
        Result.gen(async function* () {
          const transfer = yield* Result.await(at(transferId, "held"));
          if (transfer === undefined) return Result.ok(undefined);
          const { from, to, amount, currency } = transfer;
          const noted = await deps.accounts.execute(to, (account) => recordIncoming(account, { accountId: to, transferId, amount, currency, payer: from }), context);
          const refusal = noted.isErr() ? noted.error : undefined;
          if (isInfrastructureError(refusal)) return Result.err(refusal);
          yield* Result.await(
            deps.transfers.execute(
              transferId,
              (state) => (refusal === undefined ? recordCredited(state, { transferId }) : fail(state, { transferId, reason: problem(refusal, "payee") })),
              context,
            ),
          );
          return Result.ok(undefined);
        }),

      TransferCredited: ({ data: { transferId } }, context) =>
        Result.gen(async function* () {
          const transfer = yield* Result.await(at(transferId, "credited"));
          if (transfer === undefined) return Result.ok(undefined);
          yield* Result.await(deps.accounts.execute(transfer.from, (account) => sendHeld(account, { accountId: transfer.from, transferId }), context));
          yield* Result.await(deps.accounts.execute(transfer.to, (account) => receiveIncoming(account, { accountId: transfer.to, transferId }), context));
          yield* Result.await(deps.transfers.execute(transferId, (state) => complete(state, { transferId }), context));
          return Result.ok(undefined);
        }),

      // Failed is where a transfer ends, so this step needs no guard: the hold goes, if it is there.
      TransferFailed: async ({ data: { transferId, from } }, context) =>
        (await deps.accounts.execute(from, (account) => releaseHold(account, { accountId: from, transferId }), context)).map(() => undefined),
    },
  });
};
