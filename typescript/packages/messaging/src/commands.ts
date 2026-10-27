import {
  DependencyFailure,
  OperationDefect,
  Result,
  isInfrastructureError,
  noTelemetry,
  propagate,
  traceCarrier,
  type AnyContracts,
  type AnyOperationContract,
  type Application,
  type CommandQueue,
  type IdGenerator,
  type OperationResult,
  type Principal,
  type Telemetry,
} from "@projected/application";
import { z } from "zod";
import type { Disposition, MessageTransport, Subscription } from "./transport.js";

const PrincipalSchema = z.object({
  id: z.string(),
  kind: z.enum(["user", "service"]),
  permissions: z.array(z.string()),
  claims: z.record(z.string(), z.unknown()),
});

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
    /** On whose behalf the command was sent. Trusted only as far as the broker is (see `consumeCommands`). */
    principal: PrincipalSchema.optional(),
  }),
});
export type CommandMessage = z.infer<typeof CommandMessage>;

export interface CommandQueueOptions {
  readonly topic: string;
  readonly ids: IdGenerator;
  /** Records a producer span per command and puts its trace context in the message headers. */
  readonly telemetry?: Telemetry;
}

/**
 * A {@link CommandQueue} over a {@link MessageTransport}: send another service's (or your own)
 * commands for asynchronous processing. Input is validated before sending, so a malformed
 * command fails here rather than in someone else's dead-letter queue. The sender's principal
 * travels with the command.
 */
export function commandQueue<C extends AnyContracts>(
  contracts: C,
  transport: MessageTransport,
  options: CommandQueueOptions,
): CommandQueue<C> {
  const telemetry = options.telemetry ?? noTelemetry;
  return {
    contracts,
    enqueue: async (contract, input, context) => {
      const { type, version, key } = contract as AnyOperationContract;
      const data = (contract as AnyOperationContract).input.safeParse(input);
      if (!data.success) {
        return Result.err(
          new DependencyFailure({
            dependency: contracts.name,
            message: `${contracts.name}: invalid input for command ${key}`,
            cause: data.error,
          }),
        );
      }
      return telemetry.span(
        `send ${contracts.name}/${key}`,
        { kind: "producer", attributes: { "messaging.destination.name": options.topic, "projected.operation.type": type } },
        async () => {
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
              ...(metadata.principal === undefined
                ? {}
                : {
                    principal: {
                      ...metadata.principal,
                      permissions: [...metadata.principal.permissions],
                      claims: { ...metadata.principal.claims },
                    },
                  }),
            },
          };
          const headers: Record<string, string> = {};
          telemetry.inject(headers);
          const published = await transport.publish(options.topic, { id: messageId, body, headers });
          return published.map(() => ({ messageId }));
        },
      );
    },
  };
}

export interface ConsumeCommandsOptions {
  readonly topic: string;
  /** Competing-consumer group. Defaults to the application's name. */
  readonly group?: string;
  /**
   * Whose authority the commands run with. `"from-message"` (the default) trusts the principal
   * the sender attached — right when only your own services can publish to the topic. Pass a
   * fixed service principal when the topic is shared more widely.
   */
  readonly principal?: "from-message" | Principal;
  /** Observe each business outcome — async commands have no caller waiting for it. */
  readonly onOutcome?: (command: CommandMessage, result: OperationResult) => void;
  /** Called for messages that cannot be processed and are dead-lettered. */
  readonly onRejected?: (body: unknown, reason: string) => void;
}

/**
 * The messaging driving adapter: run queued commands through the application. Business
 * outcomes (success or a declared error) are acknowledged; infrastructure errors are retried;
 * unknown operations, invalid input, refused access and defects are dead-lettered. The message
 * id is the idempotency key, so a redelivered command is never run twice when the application
 * has idempotency configured.
 */
export function consumeCommands<C extends AnyContracts>(
  app: Application<C>,
  transport: MessageTransport,
  options: ConsumeCommandsOptions,
): Promise<Subscription> {
  const telemetry = app.telemetry;
  return transport.subscribe(
    options.topic,
    (message): Promise<Disposition> =>
      telemetry.continueFrom(traceCarrier(message.headers), () =>
        telemetry.span(
          `receive ${options.topic}`,
          { kind: "consumer", attributes: { "messaging.destination.name": options.topic, "messaging.message.id": message.id } },
          async (span): Promise<Disposition> => {
            const parsed = CommandMessage.safeParse(message.body);
            if (!parsed.success) {
              options.onRejected?.(message.body, "not a command message");
              span.fail("not a command message");
              return "dead-letter";
            }
            const command = parsed.data;
            const principal =
              options.principal === undefined || options.principal === "from-message"
                ? command.metadata.principal
                : options.principal;
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
                ...(principal === undefined ? {} : { principal }),
              },
            });
            if (outcome.isOk()) {
              options.onOutcome?.(command, outcome.value);
              return "ack";
            }
            // In progress elsewhere, conflicting or unavailable: all may succeed on redelivery.
            if (isInfrastructureError(outcome.error) || outcome.error._tag === "RequestInProgress") return "retry";
            options.onRejected?.(message.body, OperationDefect.is(outcome.error) ? "defect" : outcome.error.message);
            span.fail(outcome.error.message);
            return "dead-letter";
          },
        ),
      ),
    { group: options.group ?? app.contracts.name },
  );
}
