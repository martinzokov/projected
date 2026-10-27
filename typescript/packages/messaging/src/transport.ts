import { Result, type DependencyUnavailable } from "@projected/application";

/**
 * The transport SPI: the smallest surface a broker adapter (Kafka, SQS, NATS, RabbitMQ, ...) must
 * implement. Delivery is at-least-once; consumers decide what happens to each message.
 */

export interface OutgoingMessage {
  /** Unique, stable id — the deduplication key for consumers. */
  readonly id: string;
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
  subscribe(topic: string, handler: (message: Message) => Promise<Disposition>): Subscription;
}

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
 * Create an {@link InMemoryTransport}. Every subscription to a topic receives its own copy of each
 * message (fan-out). Nothing is delivered until {@link InMemoryTransport.drain} is called, which
 * keeps tests deterministic.
 */
export function inMemoryTransport(options: InMemoryTransportOptions = {}): InMemoryTransport {
  const maxAttempts = options.maxAttempts ?? 3;
  const subscribers = new Map<string, Set<(message: Message) => Promise<Disposition>>>();
  const queue: Array<{ message: Message; handler: (message: Message) => Promise<Disposition> }> = [];
  const published: Message[] = [];
  const deadLetters: Message[] = [];

  return {
    published,
    deadLetters,
    publish: async (topic, outgoing) => {
      const message: Message = {
        id: outgoing.id,
        topic,
        body: structuredClone(outgoing.body),
        headers: { ...outgoing.headers },
        attempt: 1,
      };
      published.push(message);
      for (const handler of subscribers.get(topic) ?? []) queue.push({ message, handler });
      return Result.ok(undefined);
    },
    subscribe: (topic, handler) => {
      const handlers = subscribers.get(topic) ?? new Set();
      handlers.add(handler);
      subscribers.set(topic, handlers);
      return {
        close: async () => {
          handlers.delete(handler);
        },
      };
    },
    drain: async () => {
      let deliveries = 0;
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        deliveries++;
        const { message, handler } = next;
        const disposition = await handler(message).catch((): Disposition => "retry");
        if (disposition === "dead-letter") deadLetters.push(message);
        if (disposition === "retry") {
          if (message.attempt >= maxAttempts) deadLetters.push(message);
          else queue.push({ message: { ...message, attempt: message.attempt + 1 }, handler });
        }
      }
      return deliveries;
    },
  };
}
