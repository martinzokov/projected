import {
  Result,
  aggregateRepository,
  changeTo,
  defineAggregate,
  noChange,
  z,
  type AggregateRepository,
  type CommandHandler,
  type Decision,
  type StateOf,
  type StateStore,
} from "@projected/application/state-based";
import { CloseTicket, OpenTicket, TicketAlreadyOpened, TicketClosed, TicketNotOpen, TicketOpened } from "./fixtures.js";

/** The ticketing domain of `fixtures.ts`, stored as state: same events, errors and contracts. */

export const Ticket = defineAggregate({
  name: "ticket",
  schema: z.object({ status: z.enum(["open", "closed"]), title: z.string() }),
  events: [TicketOpened, TicketClosed],
});
export type TicketState = StateOf<typeof Ticket>;

export const open = (
  state: TicketState | undefined,
  input: { ticketId: string; title: string },
): Decision<typeof Ticket, TicketAlreadyOpened> =>
  state === undefined
    ? Result.ok(changeTo({ status: "open", title: input.title }, TicketOpened(input)))
    : Result.err(new TicketAlreadyOpened({ ticketId: input.ticketId }));

export const close = (state: TicketState | undefined, ticketId: string): Decision<typeof Ticket, TicketNotOpen> => {
  if (state === undefined) return Result.err(new TicketNotOpen({ ticketId }));
  if (state.status === "closed") return Result.ok(noChange());
  return Result.ok(changeTo({ ...state, status: "closed" }, TicketClosed({ ticketId })));
};

export const openTicket =
  (deps: { tickets: AggregateRepository<typeof Ticket> }): CommandHandler<typeof OpenTicket> =>
  async (input, context) =>
    (await deps.tickets.execute(input.ticketId, (state) => open(state, input), context)).map(() => ({
      ticketId: input.ticketId,
    }));

export const closeTicket =
  (deps: { tickets: AggregateRepository<typeof Ticket> }): CommandHandler<typeof CloseTicket> =>
  async ({ ticketId }, context) =>
    (await deps.tickets.execute(ticketId, (state) => close(state, ticketId), context)).map(({ events }) => ({
      closed: events.length > 0,
    }));

export const tickets = (store: StateStore) => aggregateRepository(Ticket, store);
