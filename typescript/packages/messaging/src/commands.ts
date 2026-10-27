import {
  DependencyFailure,
  OperationDefect,
  Result,
  isInfrastructureError,
  propagate,
  type AnyContracts,
  type AnyOperationContract,
  type Application,
  type CommandQueue,
  type IdGenerator,
  type OperationResult,
} from "@projected/application";
import { z } from "zod";
import type { Disposition, MessageTransport, Subscription } from "./transport.js";

/** A command travelling through a broker. The same `{ type, version, data }` shape as an HTTP batch item. */
export const CommandMessage = z.object({
  kind: z.literal("command"),
  type: z.string(),
  version: z.number().int().positive(),
  data: z.unknown(),
  metadata: z.object({
    messageId: z.string(),
    correlationId: z.string(),
    causationId: z.string().optional(),
  }),
});
export type CommandMessage = z.infer<typeof CommandMessage>;

export interface CommandQueueOptions {
  readonly topic: string;
  readonly ids: IdGenerator;
}

/**
 * A {@link CommandQueue} over a {@link MessageTransport}: send another service's (or your own)
 * commands for asynchronous processing. Input is validated before sending, so a malformed
 * command fails here rather than in someone else's dead-letter queue.
 */
export function commandQueue<C extends AnyContracts>(
  contracts: C,
  transport: MessageTransport,
  options: CommandQueueOptions,
): CommandQueue<C> {
  return {
    contracts,
    enqueue: async (contract, input, context) => {
      const { type, version } = contract as AnyOperationContract;
      const data = (contract as AnyOperationContract).input.safeParse(input);
      if (!data.success) {
        return Result.err(
          new DependencyFailure({
            dependency: contracts.name,
            message: `${contracts.name}: invalid input for command ${type}@${version}`,
            cause: data.error,
          }),
        );
      }
      const messageId = options.ids.next();
      const metadata = propagate(context);
      const body: CommandMessage = {
        kind: "command",
        type,
        version,
        data: input,
        metadata: {
          messageId,
          correlationId: metadata.correlationId ?? messageId,
          ...(metadata.causationId === undefined ? {} : { causationId: metadata.causationId }),
        },
      };
      const published = await transport.publish(options.topic, { id: messageId, body });
      return published.map(() => ({ messageId }));
    },
  };
}

export interface ConsumeCommandsOptions {
  readonly topic: string;
  /** Observe each business outcome — async commands have no caller waiting for it. */
  readonly onOutcome?: (command: CommandMessage, result: OperationResult) => void;
  /** Called for messages that cannot be processed and are dead-lettered. */
  readonly onRejected?: (body: unknown, reason: string) => void;
}

/**
 * The messaging driving adapter: run queued commands through the application. Business
 * outcomes (success or a declared error) are acknowledged; infrastructure errors are retried;
 * unknown operations, invalid input and defects are dead-lettered.
 */
export function consumeCommands<C extends AnyContracts>(
  app: Application<C>,
  transport: MessageTransport,
  options: ConsumeCommandsOptions,
): Subscription {
  return transport.subscribe(options.topic, async (message): Promise<Disposition> => {
    const parsed = CommandMessage.safeParse(message.body);
    if (!parsed.success) {
      options.onRejected?.(message.body, "not a command message");
      return "dead-letter";
    }
    const command = parsed.data;
    const outcome = await app.dispatch({
      kind: "command",
      type: command.type,
      version: command.version,
      input: command.data,
      metadata: {
        messageId: command.metadata.messageId,
        correlationId: command.metadata.correlationId,
        causationId: command.metadata.causationId,
        idempotencyKey: command.metadata.messageId,
      },
    });
    if (outcome.isOk()) {
      options.onOutcome?.(command, outcome.value);
      return "ack";
    }
    if (isInfrastructureError(outcome.error)) return "retry";
    options.onRejected?.(message.body, OperationDefect.is(outcome.error) ? "defect" : outcome.error.message);
    return "dead-letter";
  });
}
