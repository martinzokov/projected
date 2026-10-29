import { Result, defineAggregate, type Decision } from "@projected/domain/event-sourced";
import { TransferIdInUse, TransferToSameAccount } from "./errors.js";
import {
  TransferCompleted,
  TransferCredited,
  TransferFailed,
  TransferFundsHeld,
  TransferRejected,
  TransferRequested,
  type TransferProblem,
} from "./events.js";

export interface TransferDetails {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
  readonly currency: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
}

/**
 * Where a transfer has got to. `requested` → `held` → `credited` → `completed` when all goes
 * well; `rejected` when the paying account refuses, `failed` when the receiving one does.
 */
export type TransferState =
  | { readonly status: "unknown" }
  | (TransferDetails & { readonly status: "requested" | "held" | "credited" | "completed" })
  | (TransferDetails & { readonly status: "rejected" | "failed"; readonly reason: TransferProblem });

type Step = TransferState["status"];

/** The state after a step, if the transfer exists; a history the process never writes changes nothing. */
const step = (state: TransferState, status: Exclude<Step, "unknown" | "rejected" | "failed">): TransferState =>
  state.status === "unknown" ? state : { ...details(state), status };

const details = ({ from, to, amount, currency, requestedBy, requestedAt }: TransferDetails): TransferDetails => ({ from, to, amount, currency, requestedBy, requestedAt });

export const Transfer = defineAggregate({
  name: "transfer",
  initialState: (): TransferState => ({ status: "unknown" }),
  events: [TransferRequested, TransferFundsHeld, TransferCredited, TransferCompleted, TransferRejected, TransferFailed],
  evolve: {
    TransferRequested: (_state, data) => ({ ...details(data), status: "requested" }),
    TransferFundsHeld: (state) => step(state, "held"),
    TransferCredited: (state) => step(state, "credited"),
    TransferCompleted: (state) => step(state, "completed"),
    TransferRejected: (state, { reason }) => (state.status === "unknown" ? state : { ...details(state), status: "rejected", reason }),
    TransferFailed: (state, { reason }) => (state.status === "unknown" ? state : { ...details(state), status: "failed", reason }),
  },
});

/**
 * Decisions: pure functions from the current state and a request to the events that follow,
 * or the business rule that refuses them. Each step after the request is taken only from the
 * step before it, and is otherwise a no-op — so the process can repeat any step safely.
 */

export function request(state: TransferState, input: TransferDetails & { transferId: string }): Decision<typeof Transfer, TransferToSameAccount | TransferIdInUse> {
  if (input.from === input.to) return Result.err(new TransferToSameAccount({ accountId: input.from }));
  if (state.status === "unknown") return Result.ok([TransferRequested(input)]);
  const same = state.from === input.from && state.to === input.to && state.amount === input.amount && state.currency === input.currency && state.requestedBy === input.requestedBy;
  return same ? Result.ok([]) : Result.err(new TransferIdInUse({ transferId: input.transferId }));
}

export const recordFundsHeld = (state: TransferState, input: { transferId: string }): Decision<typeof Transfer, never> =>
  Result.ok(state.status === "requested" ? [TransferFundsHeld(input)] : []);

export const reject = (state: TransferState, input: { transferId: string; reason: TransferProblem }): Decision<typeof Transfer, never> =>
  Result.ok(state.status === "requested" ? [TransferRejected(input)] : []);

export const recordCredited = (state: TransferState, input: { transferId: string }): Decision<typeof Transfer, never> =>
  Result.ok(state.status === "held" ? [TransferCredited(input)] : []);

export const fail = (state: TransferState, input: { transferId: string; reason: TransferProblem }): Decision<typeof Transfer, never> =>
  Result.ok(state.status === "held" ? [TransferFailed({ ...input, from: state.from })] : []);

export const complete = (state: TransferState, input: { transferId: string }): Decision<typeof Transfer, never> =>
  Result.ok(state.status === "credited" ? [TransferCompleted(input)] : []);
