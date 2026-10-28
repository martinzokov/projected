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

/** Header on a dead letter saying why it was dead-lettered. */
export const DEAD_LETTER_REASON_HEADER = "projected-dead-letter-reason";

/**
 * Header on a message published again on purpose — by a dead-letter replay — under the id it had.
 * A broker that drops repeated publishes of one id (NATS JetStream's deduplication) must count
 * each replay as a new publish; consumers still see the original id.
 */
export const REPLAY_HEADER = "projected-replay";
