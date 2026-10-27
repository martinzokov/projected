import {
  Result,
  aggregateRepository,
  defineAggregate,
  defineCommand,
  defineContracts,
  defineError,
  defineEvent,
  defineQuery,
  z,
  type AggregateRepository,
  type CommandHandler,
  type Decision,
  type EventStore,
  type QueryHandler,
} from "@projected/application";

/** A tiny ticketing domain used across the application tests. */

export class TicketAlreadyOpened extends defineError("TicketAlreadyOpened", {
  schema: z.object({ ticketId: z.string() }),
  message: ({ ticketId }) => `Ticket ${ticketId} is already open`,
}) {}

export class TicketNotOpen extends defineError("TicketNotOpen", {
  schema: z.object({ ticketId: z.string() }),
  message: ({ ticketId }) => `Ticket ${ticketId} is not open`,
}) {}

export const TicketOpened = defineEvent("TicketOpened", { schema: z.object({ ticketId: z.string(), title: z.string() }) });
export const TicketClosed = defineEvent("TicketClosed", { schema: z.object({ ticketId: z.string() }) });

export type TicketState = { readonly status: "none" } | { readonly status: "open" | "closed"; readonly title: string };
export const Ticket = defineAggregate({
  name: "ticket",
  initialState: (): TicketState => ({ status: "none" }),
  events: [TicketOpened, TicketClosed],
  evolve: {
    TicketOpened: (_state, { title }) => ({ status: "open", title }),
    TicketClosed: (state) => (state.status === "none" ? state : { ...state, status: "closed" }),
  },
});

export const open = (
  state: TicketState,
  input: { ticketId: string; title: string },
): Decision<typeof Ticket, TicketAlreadyOpened> =>
  state.status === "none"
    ? Result.ok([TicketOpened(input)])
    : Result.err(new TicketAlreadyOpened({ ticketId: input.ticketId }));

export const close = (state: TicketState, ticketId: string): Decision<typeof Ticket, TicketNotOpen> => {
  if (state.status === "closed") return Result.ok([]);
  if (state.status === "none") return Result.err(new TicketNotOpen({ ticketId }));
  return Result.ok([TicketClosed({ ticketId })]);
};

export const OpenTicket = defineCommand({
  type: "open-ticket",
  input: z.object({ ticketId: z.string().min(1), title: z.string().min(1) }),
  output: z.object({ ticketId: z.string() }),
  errors: [TicketAlreadyOpened],
});

export const CloseTicket = defineCommand({
  type: "close-ticket",
  input: z.object({ ticketId: z.string() }),
  output: z.object({ closed: z.boolean() }),
  errors: [TicketNotOpen],
});

export const OpenTicketTitles = defineQuery({
  type: "open-ticket-titles",
  input: z.object({}),
  output: z.object({ titles: z.array(z.string()) }),
});

export const ticketContracts = defineContracts({
  name: "tickets",
  commands: [OpenTicket, CloseTicket],
  queries: [OpenTicketTitles],
});

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

export const openTicketTitles =
  (deps: { titles: () => readonly string[] }): QueryHandler<typeof OpenTicketTitles> =>
  () =>
    Result.ok({ titles: [...deps.titles()] });

export const tickets = (store: EventStore) => aggregateRepository(Ticket, store);
