import { Result, type DependencyUnavailable, type ReadinessCheck } from "@projected/application";

/**
 * The transport SPI: the smallest surface a broker adapter (Kafka, SQS, NATS, RabbitMQ, ...) must
 * implement. Delivery is at-least-once; consumers decide what happens to each message.
 */

export interface OutgoingMessage {
  /** Unique, stable id — the deduplication key for consumers. */
  readonly id: string;
  /**
   * Partition or ordering key. Brokers that partition (Kafka) keep messages with the same key in
   * order; relayed events use their stream name, so one aggregate's events stay ordered.
   * Defaults to the id.
   */
  readonly key?: string;
  /** JSON-serializable body. */
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Message extends OutgoingMessage {
  readonly topic: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Delivery attempt, starting at 1. */
  readonly attempt: number;
}

/** What to do with a delivered message. */
export type Disposition = "ack" | "retry" | "dead-letter";

export interface Subscription {
  close(): Promise<void>;
}

export interface MessageTransport {
  publish(topic: string, message: OutgoingMessage): Promise<Result<void, DependencyUnavailable>>;
  /** Resolves once the subscription is receiving. `group` names a set of competing consumers. */
  subscribe(
    topic: string,
    handler: (message: Message) => Promise<Disposition>,
    options?: SubscribeOptions,
  ): Promise<Subscription>;
  /**
   * Whether the broker answers now — for readiness probes ({@link transportReadiness}). Must
   * answer promptly, unavailable rather than hanging when the broker is unreachable.
   */
  ping(): Promise<Result<void, DependencyUnavailable>>;
  /** Release connections. */
  close?(): Promise<void>;
}

/** A transport as a readiness check: the service is not ready while its broker is unreachable. */
export function transportReadiness(name: string, transport: MessageTransport): ReadinessCheck {
  return { name, check: () => transport.ping() };
}

export interface SubscribeOptions {
  /**
   * Consumers in the same group share the topic's messages; each group gets every message.
   * Defaults to one group per topic. Name it after the consuming service.
   */
  readonly group?: string;
}

/** Name of the topic that receives a topic's dead letters. The same convention on every transport. */
export const deadLetterTopic = (topic: string) => `${topic}.dead-letter`;

/** An in-memory transport with explicit delivery, for tests and single-process development. */
export interface InMemoryTransport extends MessageTransport {
  /** Deliver queued messages (and their retries) until none are left. Returns the number of deliveries. */
  drain(): Promise<number>;
  /** Every message ever published, in order. */
  readonly published: readonly Message[];
  /** Messages that were dead-lettered or exhausted their attempts. */
  readonly deadLetters: readonly Message[];
}

export interface InMemoryTransportOptions {
  /** Deliveries per message before it is dead-lettered. Defaults to 3. */
  readonly maxAttempts?: number;
}

/**
 * Create an {@link InMemoryTransport}. Each consumer group receives every message; subscriptions
 * in the same group take turns. Nothing is delivered until {@link InMemoryTransport.drain} is
 * called, which keeps tests deterministic. Not durable: only groups subscribed at publish time
 * receive a message.
 */
export function inMemoryTransport(options: InMemoryTransportOptions = {}): InMemoryTransport {
  const maxAttempts = options.maxAttempts ?? 3;
  type Handler = (message: Message) => Promise<Disposition>;
  const groups = new Map<string, Map<string, { handlers: Handler[]; next: number }>>();
  const queue: Array<{ message: Message; group: string }> = [];
  const published: Message[] = [];
  const deadLetters: Message[] = [];

  const enqueue = (message: Message) => {
    for (const group of groups.get(message.topic)?.keys() ?? []) queue.push({ message, group });
  };
  const handlerFor = (topic: string, group: string): Handler | undefined => {
    const members = groups.get(topic)?.get(group);
    if (members === undefined || members.handlers.length === 0) return undefined;
    const handler = members.handlers[members.next % members.handlers.length];
    members.next++;
    return handler;
  };
  const deadLetter = (message: Message) => {
    deadLetters.push(message);
    enqueue({ ...message, topic: deadLetterTopic(message.topic), attempt: 1 });
  };

  const transport: InMemoryTransport = {
    published,
    deadLetters,
    ping: async () => Result.ok(undefined),
    publish: async (topic, outgoing) => {
      const message: Message = {
        id: outgoing.id,
        key: outgoing.key ?? outgoing.id,
        topic,
        body: structuredClone(outgoing.body),
        headers: { ...outgoing.headers },
        attempt: 1,
      };
      published.push(message);
      enqueue(message);
      return Result.ok(undefined);
    },
    subscribe: async (topic, handler, subscribeOptions = {}) => {
      const group = subscribeOptions.group ?? "default";
      const topicGroups = groups.get(topic) ?? new Map<string, { handlers: Handler[]; next: number }>();
      const members = topicGroups.get(group) ?? { handlers: [], next: 0 };
      members.handlers.push(handler);
      topicGroups.set(group, members);
      groups.set(topic, topicGroups);
      return {
        close: async () => {
          members.handlers = members.handlers.filter((candidate) => candidate !== handler);
        },
      };
    },
    drain: async () => {
      let deliveries = 0;
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const { message, group } = next;
        const handler = handlerFor(message.topic, group);
        if (handler === undefined) continue;
        deliveries++;
        const disposition = await handler(message).catch((): Disposition => "retry");
        if (disposition === "dead-letter") deadLetter(message);
        if (disposition === "retry") {
          if (message.attempt >= maxAttempts) deadLetter(message);
          else queue.push({ message: { ...message, attempt: message.attempt + 1 }, group });
        }
      }
      return deliveries;
    },
  };
  return transport;
}
