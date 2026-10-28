import { Result, defineOperatorTask, z, type DependencyUnavailable, type OperatorTask } from "@projected/application";
import { sleep } from "./timing.js";
import { DEAD_LETTER_REASON_HEADER, REPLAY_HEADER, deadLetterTopic, type MessageTransport } from "./transport.js";

export interface DeadLetterReplayOptions {
  /** The topics whose dead letters may be replayed: the ones this service consumes. */
  readonly topics: readonly [string, ...string[]];
  /**
   * The consumer group reading the dead-letter topics. The broker keeps its position, so each
   * dead letter is replayed once. Defaults to `projected-dead-letter-replay`.
   */
  readonly group?: string;
  /** Finish once no dead letter has arrived for this long. Defaults to 2 s. */
  readonly idleMs?: number;
  /** Finish after this long, whatever is still arriving; the rest waits for the next run. Defaults to 60 s. */
  readonly maxMs?: number;
}

/**
 * The `replay-dead-letters` operator task: publish a topic's dead letters back to the topic, under
 * their own ids, once whatever made them fail is fixed. Commands rerun (a dead-lettered command
 * never completed, so its idempotency key is free) and events reach their consumers again.
 *
 * ```ts
 * createApplication(contracts, { ..., operatorTasks: [deadLetterReplay(transport, { topics: ["billing.commands"] })] });
 * ```
 */
export function deadLetterReplay(transport: MessageTransport, options: DeadLetterReplayOptions): OperatorTask {
  const group = options.group ?? "projected-dead-letter-replay";
  const idleMs = options.idleMs ?? 2000;
  const maxMs = options.maxMs ?? 60_000;
  return defineOperatorTask({
    name: "replay-dead-letters",
    description: `Publish a topic's dead letters back to it, once what made them fail is fixed. Topics: ${options.topics.join(", ")}.`,
    input: z.object({ topic: z.enum(options.topics) }),
    run: async ({ topic }) => {
      const replay = globalThis.crypto.randomUUID();
      const started = Date.now();
      let lastArrival = started;
      let replayed = 0;
      let failure: DependencyUnavailable | undefined;
      const subscription = await transport.subscribe(
        deadLetterTopic(topic),
        async (message) => {
          lastArrival = Date.now();
          const { [DEAD_LETTER_REASON_HEADER]: _reason, ...headers } = message.headers;
          const published = await transport.publish(topic, {
            id: message.id,
            key: message.key ?? message.id,
            body: message.body,
            headers: { ...headers, [REPLAY_HEADER]: replay },
          });
          if (published.isErr()) {
            failure = published.error;
            // Unacknowledged, so not lost: redelivered to the next run (or dead-lettered again once the transport gives up).
            return "retry";
          }
          replayed++;
          return "ack";
        },
        { group },
      );
      while (failure === undefined && Date.now() - lastArrival < idleMs && Date.now() - started < maxMs) await sleep(Math.min(idleMs, 50));
      await subscription.close();
      return failure === undefined ? Result.ok({ topic, replayed }) : Result.err(failure);
    },
  });
}
