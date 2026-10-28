/**
 * @projected/nats — a {@link MessageTransport} over NATS JetStream: one small server binary,
 * persistent streams, and native per-message acknowledgement, delayed redelivery and
 * termination. A lightweight alternative to Kafka when you do not need partitioned logs at scale.
 *
 * Every topic is a subject `<prefix>.<topic>` in one stream; every consumer group is a durable
 * pull consumer on that subject. Publishing de-duplicates by message id within the stream's
 * duplicate window.
 */
import { DependencyUnavailable, Result } from "@projected/application";
import { deadLetterTopic, type Disposition, type MessageTransport, type Subscription } from "@projected/messaging";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager, type JsMsg } from "@nats-io/jetstream";
import { connect, headers as natsHeaders, nanos, type NatsConnection } from "@nats-io/transport-node";

export interface NatsTransportOptions {
  /** `nats://host:port` of one or more servers. */
  readonly servers: string | readonly string[];
  /** JetStream stream holding every topic. Created when missing. Defaults to `PROJECTED`. */
  readonly stream?: string;
  /** Subject prefix; topics become `<prefix>.<topic>`. Defaults to `projected`. */
  readonly subjectPrefix?: string;
  /** Deliveries of one message before it is dead-lettered. Defaults to 5. */
  readonly maxAttempts?: number;
  /** Wait before delivery `attempt + 1`. Defaults to 200 ms doubling, at most 10 s. */
  readonly retryDelayMs?: (attempt: number) => number;
  /** How long a delivered message may stay unacknowledged before JetStream redelivers it. Defaults to 30 s. */
  readonly ackWaitMs?: number;
  /**
   * Unacknowledged messages a consumer group may hold at once. The default, 1, keeps strict
   * order — retries included — at the cost of throughput; raise it where order does not matter.
   */
  readonly maxInFlight?: number;
  readonly onError?: (error: unknown) => void;
  /** How long a readiness ping waits for the server. Defaults to 2 s. */
  readonly pingTimeoutMs?: number;
}

const MESSAGE_ID = "projected-message-id";
const KEY = "projected-key";
const DEAD_LETTER_REASON = "projected-dead-letter-reason";
/** NATS consumer names may not contain `.`, `*`, `>` or whitespace. */
const consumerName = (group: string, topic: string) => `${group}__${topic}`.replace(/[^A-Za-z0-9_-]/g, "_");

/** `work`, or a rejection once `ms` have passed without an answer. */
const within = <T>(ms: number, work: Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** Create a NATS JetStream {@link MessageTransport}. Call `close()` on shutdown. */
export function natsTransport(options: NatsTransportOptions): MessageTransport & { close(): Promise<void> } {
  const streamName = options.stream ?? "PROJECTED";
  const prefix = options.subjectPrefix ?? "projected";
  const maxAttempts = options.maxAttempts ?? 5;
  const retryDelay = options.retryDelayMs ?? ((attempt: number) => Math.min(200 * 2 ** (attempt - 1), 10_000));
  const onError = options.onError ?? (() => undefined);
  const pingTimeoutMs = options.pingTimeoutMs ?? 2000;
  const subjectOf = (topic: string) => `${prefix}.${topic}`;

  let connecting: Promise<NatsConnection> | undefined;
  const connection = () =>
    (connecting ??= (async () => {
      const nc = await connect({ servers: typeof options.servers === "string" ? options.servers : [...options.servers] });
      const jsm = await jetstreamManager(nc);
      try {
        await jsm.streams.info(streamName);
      } catch {
        await jsm.streams.add({ name: streamName, subjects: [`${prefix}.>`] });
      }
      return nc;
    })().catch((error: unknown) => {
      connecting = undefined;
      throw error;
    }));

  const send = async (topic: string, id: string, body: Uint8Array | string, headerValues: Record<string, string>) => {
    const nc = await connection();
    const h = natsHeaders();
    for (const [name, value] of Object.entries(headerValues)) h.set(name, value);
    await jetstream(nc).publish(subjectOf(topic), body, { msgID: id, headers: h });
  };

  const subscriptions = new Set<Subscription>();

  return {
    ping: async () => {
      try {
        await within(pingTimeoutMs, connection().then((nc) => nc.flush()));
        return Result.ok(undefined);
      } catch (cause) {
        return Result.err(new DependencyUnavailable({ dependency: "nats", message: `nats: the server did not answer (${String(cause)})`, cause }));
      }
    },

    publish: async (topic, message) => {
      try {
        await send(topic, message.id, JSON.stringify(message.body), {
          ...message.headers,
          [MESSAGE_ID]: message.id,
          [KEY]: message.key ?? message.id,
        });
        return Result.ok(undefined);
      } catch (cause) {
        return Result.err(new DependencyUnavailable({ dependency: "nats", message: `nats: cannot publish to ${topic}`, cause }));
      }
    },

    subscribe: async (topic, handler, subscribeOptions = {}) => {
      const nc = await connection();
      const jsm = await jetstreamManager(nc);
      const durable = consumerName(subscribeOptions.group ?? "default", topic);
      try {
        await jsm.consumers.info(streamName, durable);
      } catch {
        await jsm.consumers.add(streamName, {
          durable_name: durable,
          filter_subject: subjectOf(topic),
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.All,
          ack_wait: nanos(options.ackWaitMs ?? 30_000),
          max_ack_pending: options.maxInFlight ?? 1,
        });
      }
      const consumer = await jetstream(nc).consumers.get(streamName, durable);
      const messages = await consumer.consume();

      const settle = async (raw: JsMsg): Promise<void> => {
        const headerValues: Record<string, string> = {};
        for (const [name, values] of raw.headers ?? []) {
          const value = values[0];
          if (value !== undefined) headerValues[name] = value;
        }
        const id = headerValues[MESSAGE_ID] ?? `${raw.info.stream}/${raw.seq}`;
        const attempt = raw.info.deliveryCount;
        let body: unknown;
        try {
          body = raw.json();
        } catch {
          body = raw.string();
        }
        let disposition: Disposition;
        try {
          disposition = await handler({ id, key: headerValues[KEY] ?? id, topic, body, headers: headerValues, attempt });
        } catch (error) {
          onError(error);
          disposition = "retry";
        }
        if (disposition === "ack") return raw.ack();
        if (disposition === "retry" && attempt < maxAttempts) return raw.nak(retryDelay(attempt));
        // Dead letter under a new message id: JetStream de-duplicates ids across the whole stream.
        try {
          await send(deadLetterTopic(topic), `${id}:dead-letter`, raw.data, {
            ...headerValues,
            [DEAD_LETTER_REASON]: disposition === "dead-letter" ? "rejected" : `failed ${maxAttempts} deliveries`,
          });
          raw.term(disposition);
        } catch (error) {
          // Leave it unacknowledged: JetStream redelivers it after ack_wait instead of losing it.
          onError(error);
        }
      };

      const loop = (async () => {
        for await (const raw of messages) await settle(raw);
      })().catch(onError);

      const subscription: Subscription = {
        close: async () => {
          subscriptions.delete(subscription);
          await messages.close().catch(onError);
          await loop;
        },
      };
      subscriptions.add(subscription);
      return subscription;
    },

    close: async () => {
      await Promise.all([...subscriptions].map((subscription) => subscription.close()));
      const pending = connecting;
      connecting = undefined;
      if (pending !== undefined) await (await pending).drain().catch(onError);
    },
  };
}
