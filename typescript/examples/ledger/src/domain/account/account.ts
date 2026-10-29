import { Result, defineAggregate, z, type Decision } from "@projected/domain/event-sourced";
import { AccountAlreadyOpened, AccountNotEmpty, AccountNotOpen, CurrencyMismatch, InsufficientFunds, NotAccountHolder } from "./errors.js";
import {
  AccountClosed,
  AccountOpened,
  FundsHeld,
  HoldReleased,
  IncomingTransferRecorded,
  MoneyDeposited,
  MoneyWithdrawn,
  TransferReceived,
  TransferSent,
} from "./events.js";

/** Transfers in flight, by transfer id: the amount and the account on the other side. */
const InFlight = z.record(z.string(), z.object({ amount: z.number().int(), counterparty: z.string() }));

/** What decisions about one account need: its balance, and the transfers not yet booked. */
export const AccountState = z.object({
  status: z.enum(["unknown", "open", "closed"]),
  holder: z.string(),
  currency: z.string(),
  /** Booked money, in minor units. */
  balance: z.number().int(),
  /** Outgoing transfers whose funds are set aside. */
  held: InFlight,
  /** Incoming transfers not yet booked. */
  incoming: InFlight,
});
export type AccountState = Readonly<z.infer<typeof AccountState>>;

type InFlight = AccountState["held"];
const without = (inFlight: InFlight, transferId: string): InFlight => Object.fromEntries(Object.entries(inFlight).filter(([id]) => id !== transferId));
/** Own entries only: a transfer id such as `constructor` must not find `Object.prototype`'s. */
const inFlightAs = (inFlight: InFlight, transferId: string) => (Object.hasOwn(inFlight, transferId) ? inFlight[transferId] : undefined);

export const Account = defineAggregate({
  name: "account",
  initialState: (): AccountState => ({ status: "unknown", holder: "", currency: "", balance: 0, held: {}, incoming: {} }),
  events: [AccountOpened, MoneyDeposited, MoneyWithdrawn, FundsHeld, HoldReleased, TransferSent, IncomingTransferRecorded, TransferReceived, AccountClosed],
  evolve: {
    AccountOpened: (state, { holder, currency }) => ({ ...state, status: "open", holder, currency }),
    MoneyDeposited: (state, { amount }) => ({ ...state, balance: state.balance + amount }),
    MoneyWithdrawn: (state, { amount }) => ({ ...state, balance: state.balance - amount }),
    FundsHeld: (state, { transferId, amount, payee }) => ({ ...state, held: { ...state.held, [transferId]: { amount, counterparty: payee } } }),
    HoldReleased: (state, { transferId }) => ({ ...state, held: without(state.held, transferId) }),
    TransferSent: (state, { transferId, amount }) => ({ ...state, balance: state.balance - amount, held: without(state.held, transferId) }),
    IncomingTransferRecorded: (state, { transferId, amount, payer }) => ({
      ...state,
      incoming: { ...state.incoming, [transferId]: { amount, counterparty: payer } },
    }),
    TransferReceived: (state, { transferId, amount }) => ({ ...state, balance: state.balance + amount, incoming: without(state.incoming, transferId) }),
    AccountClosed: (state) => ({ ...state, status: "closed" }),
  },
  // Accounts live for years: load from the latest snapshot and the events after it.
  snapshot: { schema: AccountState, version: 1, every: 100 },
});

/** What can be spent or paid out: the balance, less what outgoing transfers hold. */
export const available = (state: AccountState): number => Object.values(state.held).reduce((rest, { amount }) => rest - amount, state.balance);

/**
 * Decisions: pure functions from the current state and a request to the events that follow,
 * or the business rule that refuses them. No I/O, no clock, no randomness — anything like that
 * arrives as input.
 */

/** Open and in the currency asked for, or why not. */
function usable(state: AccountState, accountId: string, currency: string): AccountNotOpen | CurrencyMismatch | undefined {
  if (state.status !== "open") return new AccountNotOpen({ accountId });
  if (state.currency !== currency) return new CurrencyMismatch({ accountId, accountCurrency: state.currency, currency });
  return undefined;
}

export function open(state: AccountState, input: { accountId: string; holder: string; currency: string }): Decision<typeof Account, AccountAlreadyOpened> {
  if (state.status === "unknown") return Result.ok([AccountOpened(input)]);
  if (state.status === "open" && state.holder === input.holder && state.currency === input.currency) return Result.ok([]);
  return Result.err(new AccountAlreadyOpened({ accountId: input.accountId }));
}

export function deposit(
  state: AccountState,
  input: { accountId: string; amount: number; currency: string; reference: string },
): Decision<typeof Account, AccountNotOpen | CurrencyMismatch> {
  const problem = usable(state, input.accountId, input.currency);
  if (problem !== undefined) return Result.err(problem);
  return Result.ok([MoneyDeposited({ accountId: input.accountId, amount: input.amount, reference: input.reference })]);
}

export function withdraw(
  state: AccountState,
  input: { accountId: string; amount: number; currency: string; reference: string },
): Decision<typeof Account, AccountNotOpen | CurrencyMismatch | InsufficientFunds> {
  const problem = usable(state, input.accountId, input.currency);
  if (problem !== undefined) return Result.err(problem);
  if (available(state) < input.amount) return Result.err(new InsufficientFunds({ accountId: input.accountId, available: available(state), requested: input.amount }));
  return Result.ok([MoneyWithdrawn({ accountId: input.accountId, amount: input.amount, reference: input.reference })]);
}

export function close(state: AccountState, input: { accountId: string }): Decision<typeof Account, AccountNotOpen | AccountNotEmpty> {
  if (state.status === "closed") return Result.ok([]);
  if (state.status === "unknown") return Result.err(new AccountNotOpen(input));
  const transfersInFlight = Object.keys(state.held).length + Object.keys(state.incoming).length;
  if (state.balance !== 0 || transfersInFlight > 0) return Result.err(new AccountNotEmpty({ accountId: input.accountId, balance: state.balance, transfersInFlight }));
  return Result.ok([AccountClosed(input)]);
}

/**
 * Set funds aside for an outgoing transfer, if the holder asked for it and they are there.
 * Holding the same transfer again changes nothing, so the step can be retried.
 */
export function holdFunds(
  state: AccountState,
  input: { accountId: string; transferId: string; amount: number; currency: string; payee: string; requestedBy: string },
): Decision<typeof Account, AccountNotOpen | CurrencyMismatch | NotAccountHolder | InsufficientFunds> {
  if (inFlightAs(state.held, input.transferId) !== undefined) return Result.ok([]);
  const problem = usable(state, input.accountId, input.currency);
  if (problem !== undefined) return Result.err(problem);
  if (state.holder !== input.requestedBy) return Result.err(new NotAccountHolder({ accountId: input.accountId }));
  if (available(state) < input.amount) return Result.err(new InsufficientFunds({ accountId: input.accountId, available: available(state), requested: input.amount }));
  return Result.ok([FundsHeld({ accountId: input.accountId, transferId: input.transferId, amount: input.amount, payee: input.payee })]);
}

/** Give a transfer's hold back. Nothing to do once it is gone: released, or booked. */
export function releaseHold(state: AccountState, input: { accountId: string; transferId: string }): Decision<typeof Account, never> {
  const hold = inFlightAs(state.held, input.transferId);
  return Result.ok(hold === undefined ? [] : [HoldReleased({ ...input, amount: hold.amount })]);
}

/** Book a held transfer out of the account. Nothing to do once it is booked. */
export function sendHeld(state: AccountState, input: { accountId: string; transferId: string }): Decision<typeof Account, never> {
  const hold = inFlightAs(state.held, input.transferId);
  return Result.ok(hold === undefined ? [] : [TransferSent({ ...input, amount: hold.amount, payee: hold.counterparty })]);
}

/** Note a transfer on its way in, if the account can take it. Noting it again changes nothing. */
export function recordIncoming(
  state: AccountState,
  input: { accountId: string; transferId: string; amount: number; currency: string; payer: string },
): Decision<typeof Account, AccountNotOpen | CurrencyMismatch> {
  if (inFlightAs(state.incoming, input.transferId) !== undefined) return Result.ok([]);
  const problem = usable(state, input.accountId, input.currency);
  if (problem !== undefined) return Result.err(problem);
  return Result.ok([IncomingTransferRecorded({ accountId: input.accountId, transferId: input.transferId, amount: input.amount, payer: input.payer })]);
}

/** Book an incoming transfer into the account. Nothing to do once it is booked. */
export function receiveIncoming(state: AccountState, input: { accountId: string; transferId: string }): Decision<typeof Account, never> {
  const incoming = inFlightAs(state.incoming, input.transferId);
  return Result.ok(incoming === undefined ? [] : [TransferReceived({ ...input, amount: incoming.amount, payer: incoming.counterparty })]);
}
