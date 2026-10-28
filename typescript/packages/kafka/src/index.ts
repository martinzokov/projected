/**
 * @projected/kafka — a {@link MessageTransport} over Apache Kafka. Infrastructure-only: create it
 * in the composition root and hand it to `commandQueue`, `consumeCommands`, `eventRelay` and
 * `consumeEvents` from `@projected/messaging`.
 *
 * Semantics: at-least-once. Offsets are committed only after a message is acknowledged or
 * dead-lettered. Kafka has no per-message negative acknowledgement, so a message to retry is
 * retried in place, with backoff, before the consumer moves on — which keeps every partition in
 * order. After `maxAttempts` it goes to `<topic>.dead-letter` and the partition continues.
 */
import { DependencyUnavailable, Result } from "@projected/application";
import {
  DEAD_LETTER_REASON_HEADER,
  deadLetterTopic,
  sleep,
  withTimeout,
  type Disposition,
  type Message,
  type MessageTransport,
  type Subscription,
} from "@projected/messaging";
import { Admin, Consumer, Producer, stringDeserializers, stringSerializers } from "@platformatic/kafka";

export interface KafkaTransportOptions {
  /** `host:port` of one or more brokers. */
  readonly brokers: readonly string[];
  readonly clientId?: string;
  /** Deliveries of one message before it is dead-lettered. Defaults to 5. */
  readonly maxAttempts?: number;
  /** Wait before delivery `attempt + 1`. Defaults to 200 ms doubling, at most 10 s. */
  readonly retryDelayMs?: (attempt: number) => number;
  /**
   * Create topics the first time they are used, with these settings. Convenient in development;
   * turn it off where topics are provisioned separately. Defaults to 1 partition, 1 replica.
   */
  readonly createTopics?: false | { readonly partitions: number; readonly replicas: number };
  /** Errors outside any one message: lost connections, failed commits. */
  readonly onError?: (error: unknown) => void;
  /** How long a readiness ping waits for the broker. Defaults to 2 s. */
  readonly pingTimeoutMs?: number;
}

const MESSAGE_ID = "projected-message-id";

/** Create a Kafka-backed {@link MessageTransport}. Call `close()` on shutdown. */
export function kafkaTransport(options: KafkaTransportOptions): MessageTransport & { close(): Promise<void> } {
  const clientId = options.clientId ?? "projected";
  const bootstrapBrokers = [...options.brokers];
  const maxAttempts = options.maxAttempts ?? 5;
  const retryDelay = options.retryDelayMs ?? ((attempt: number) => Math.min(200 * 2 ** (attempt - 1), 10_000));
  const createTopics = options.createTopics ?? { partitions: 1, replicas: 1 };
  const onError = options.onError ?? (() => undefined);
  const pingTimeoutMs = options.pingTimeoutMs ?? 2000;

  let producer: Producer<string, string, string, string> | undefined;
  const producerOf = () =>
    (producer ??= new Producer({ clientId: `${clientId}-producer`, bootstrapBrokers, serializers: stringSerializers }));

  const ensured = new Map<string, Promise<void>>();
  const ensureTopic = (topic: string): Promise<void> => {
    if (createTopics === false) return Promise.resolve();
    const existing = ensured.get(topic);
    if (existing !== undefined) return existing;
    const creating = (async () => {
      const admin = new Admin({ clientId: `${clientId}-admin`, bootstrapBrokers });
      try {
        await admin.createTopics({ topics: [topic], partitions: createTopics.partitions, replicas: createTopics.replicas });
      } catch (error) {
        if (!/already exists/i.test(JSON.stringify(error, Object.getOwnPropertyNames(error)))) throw error;
      } finally {
        await admin.close();
      }
    })();
    ensured.set(topic, creating);
    creating.catch(() => ensured.delete(topic));
    return creating;
  };

  const send = async (topic: string, key: string, value: string, headers: Record<string, string>) => {
    await ensureTopic(topic);
    await producerOf().send({ messages: [{ topic, key, value, headers }] });
  };

  const subscriptions = new Set<Subscription>();

  const transport: MessageTransport & { close(): Promise<void> } = {
    ping: async () => {
      try {
        await withTimeout(pingTimeoutMs, producerOf().metadata({ topics: [], forceUpdate: true }));
        return Result.ok(undefined);
      } catch (cause) {
        return Result.err(new DependencyUnavailable({ dependency: "kafka", message: `kafka: no broker answered (${String(cause)})`, cause }));
      }
    },

    publish: async (topic, message) => {
      try {
        await send(topic, message.key ?? message.id, JSON.stringify(message.body), { ...message.headers, [MESSAGE_ID]: message.id });
        return Result.ok(undefined);
      } catch (cause) {
        return Result.err(new DependencyUnavailable({ dependency: "kafka", message: `kafka: cannot publish to ${topic}`, cause }));
      }
    },

    subscribe: async (topic, handler, subscribeOptions = {}) => {
      await ensureTopic(topic);
      const consumer = new Consumer({
        groupId: subscribeOptions.group ?? `projected.${topic}`,
        clientId: `${clientId}-consumer`,
        bootstrapBrokers,
        deserializers: stringDeserializers,
      });
      const stream = await consumer.consume({ topics: [topic], autocommit: false, mode: "committed", fallbackMode: "earliest" });
      let closing = false;

      /**
       * Write a dead letter, retrying with backoff until it is written or the subscription closes.
       * The partition waits meanwhile: moving on would lose the message, and giving up would stall
       * the partition for good while the consumer still holds it.
       */
      const deadLetter = async (write: () => Promise<void>): Promise<boolean> => {
        for (let attempt = 1; !closing; attempt++) {
          try {
            await write();
            return true;
          } catch (error) {
            onError(error);
            await sleep(retryDelay(Math.min(attempt, maxAttempts)));
          }
        }
        return false;
      };

      const deliver = async (message: Message): Promise<Disposition> => {
        try {
          return await handler(message);
        } catch (error) {
          onError(error);
          return "retry";
        }
      };

      const loop = (async () => {
        for await (const record of stream) {
          if (closing) break;
          const headers = Object.fromEntries(record.headers) as Record<string, string>;
          const base = {
            id: headers[MESSAGE_ID] ?? `${record.topic}/${record.partition}/${record.offset}`,
            key: record.key ?? undefined,
            topic,
            body: (() => {
              try {
                return JSON.parse(record.value) as unknown;
              } catch {
                return record.value;
              }
            })(),
            headers,
          };
          let disposition: Disposition = "retry";
          let attempt = 1;
          for (; attempt <= maxAttempts && !closing; attempt++) {
            disposition = await deliver({ ...base, key: base.key ?? base.id, attempt });
            if (disposition !== "retry") break;
            if (attempt < maxAttempts) await sleep(retryDelay(attempt));
          }
          if (closing && disposition === "retry") break;
          if (disposition !== "ack") {
            const reason = disposition === "dead-letter" ? "rejected" : `failed ${maxAttempts} deliveries`;
            const parked = await deadLetter(() =>
              send(deadLetterTopic(topic), base.key ?? base.id, record.value, { ...headers, [DEAD_LETTER_REASON_HEADER]: reason }),
            );
            // Closing before the dead letter was written: uncommitted, the message comes back after a restart.
            if (!parked) break;
          }
          await record.commit();
        }
      })().catch(onError);

      const subscription: Subscription = {
        close: async () => {
          closing = true;
          subscriptions.delete(subscription);
          await stream.close().catch(onError);
          await loop;
          await consumer.close().catch(onError);
        },
      };
      subscriptions.add(subscription);
      return subscription;
    },

    close: async () => {
      await Promise.all([...subscriptions].map((subscription) => subscription.close()));
      await producer?.close().catch(onError);
      producer = undefined;
    },
  };
  return transport;
}
