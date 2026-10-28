import { DependencyUnavailable, Result } from "@projected/application";
import {
  DEAD_LETTER_REASON_HEADER,
  deadLetterTopic,
  type Disposition,
  type Message,
  type MessageTransport,
  type OutgoingMessage,
  type Subscription,
} from "./transport.js";

/**
 * When `publish` returns, and who delivers:
 *
 * - `"acknowledged"` — the transport delivers at once, and `publish` returns when every consumer
 *   group subscribed to the topic has handled the message. A relay or policy only moves its
 *   checkpoint past an event once its consumers are done, so a crash loses nothing: after a
 *   restart they publish it again. At-least-once, as with a broker.
 * - `"async"` — the transport delivers at once, and `publish` returns as soon as the message is
 *   queued. Faster; a message not yet handled when the process dies is lost.
 * - `"queued"` — nothing is delivered until {@link InMemoryTransport.drain}: for tests that step
 *   through.
 */
export type InMemoryDelivery = "acknowledged" | "async" | "queued";

export interface InMemoryTransportOptions {
  /** Defaults to `"acknowledged"`. */
  readonly delivery?: InMemoryDelivery;
  /** Deliveries per message before it is dead-lettered. Defaults to 3. */
  readonly maxAttempts?: number;
  /** Wait before delivery `attempt + 1`, except when queued. Defaults to 50 ms doubling, at most 2 s. */
  readonly retryDelayMs?: (attempt: number) => number;
  /**
   * Messages kept per topic for consumer groups that subscribe later, and at most waiting for a
   * group with no subscriber; also the length of `published` and `deadLetters`. Defaults to 10 000.
   */
  readonly retain?: number;
  /** How long an acknowledged `publish` waits for its consumers before it fails. Defaults to 30 s. */
  readonly ackTimeoutMs?: number;
  /** A consumer that threw (its message is retried), or a message dropped for lack of room. */
  readonly onError?: (error: unknown) => void;
  /** A message set aside, and why. Dead letters live in memory: log or store them to keep them. */
  readonly onDeadLetter?: (message: Message, reason: string) => void;
}

/** A {@link MessageTransport} within one process, with no broker. */
export interface InMemoryTransport extends MessageTransport {
  /**
   * Deliver what is waiting. Queued: deliver everything, retries included, and return the number
   * of deliveries. Otherwise: wait until nothing is waiting or being delivered.
   */
  drain(): Promise<number>;
  /** Deliver what is waiting, then stop: later publishes fail, and so does `ping()`. */
  close(): Promise<void>;
  /** The latest messages published, oldest first. */
  readonly published: readonly Message[];
  /** The latest messages dead-lettered, oldest first. */
  readonly deadLetters: readonly Message[];
}

type Handler = (message: Message) => Promise<Disposition>;

/** One message waiting for one group, and the publisher waiting on it, if any. */
interface Pending {
  readonly message: Message;
  settle?: ((handled: boolean) => void) | undefined;
}

interface Group {
  readonly name: string;
  readonly members: Handler[];
  next: number;
  readonly pending: Pending[];
  /** The group's delivery loop while it runs: one message at a time, in order. */
  running?: Promise<void> | undefined;
}

interface Topic {
  readonly log: Message[];
  readonly groups: Map<string, Group>;
}

const defaultRetryDelay = (attempt: number) => Math.min(50 * 2 ** (attempt - 1), 2_000);

/** Tell the waiting publisher, once, whether its group handled the message. */
const settle = (pending: Pending, handled: boolean) => {
  const waiting = pending.settle;
  pending.settle = undefined;
  waiting?.(handled);
};

/** A copy as a broker would give it back: through JSON. */
const asJson = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

/**
 * Create an {@link InMemoryTransport}: a broker's semantics within one process — consumer groups
 * that each get every message, members of a group taking turns, per-key order, bounded
 * redelivery and `<topic>.dead-letter` — so that `consumeCommands`, `consumeEvents` and
 * `eventRelay` work the same with or without Kafka or NATS. Each group handles one message at a
 * time; a message asking to be retried is redelivered before anything after it.
 *
 * With `"acknowledged"` delivery, subscribe consumers before relays start: a message published
 * while a topic has no consumer group is kept only in memory, for groups that subscribe later.
 */
export function inMemoryTransport(options: InMemoryTransportOptions = {}): InMemoryTransport {
  const delivery = options.delivery ?? "acknowledged";
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelay = options.retryDelayMs ?? defaultRetryDelay;
  const retain = options.retain ?? 10_000;
  const ackTimeoutMs = options.ackTimeoutMs ?? 30_000;
  const onError = options.onError ?? (() => undefined);

  const topics = new Map<string, Topic>();
  const published: Message[] = [];
  const deadLetters: Message[] = [];
  let closed = false;
  let deliveries = 0;

  const keepLast = <T>(list: T[], item: T, onDrop?: (dropped: T) => void) => {
    list.push(item);
    while (list.length > retain) {
      const dropped = list.shift();
      if (dropped !== undefined) onDrop?.(dropped);
    }
  };
  const topicOf = (name: string): Topic => {
    let topic = topics.get(name);
    if (topic === undefined) topics.set(name, (topic = { log: [], groups: new Map() }));
    return topic;
  };
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const deadLetter = (message: Message, reason: string) => {
    const dead: Message = { ...message, topic: deadLetterTopic(message.topic), headers: { ...message.headers, [DEAD_LETTER_REASON_HEADER]: reason }, attempt: 1 };
    keepLast(deadLetters, dead);
    options.onDeadLetter?.(dead, reason);
    enqueue(dead);
  };

  /** Hand `message` to every group of its topic, each telling `waitFor` how it went; returns how many groups. */
  const enqueue = (message: Message, waitFor?: (handled: boolean) => void): number => {
    const topic = topicOf(message.topic);
    keepLast(topic.log, message);
    let groups = 0;
    for (const group of topic.groups.values()) {
      groups++;
      keepLast(group.pending, { message, ...(waitFor === undefined ? {} : { settle: waitFor }) }, (dropped) => {
        settle(dropped, false);
        onError(new Error(`in-memory transport: group ${group.name} dropped ${dropped.message.id} on ${message.topic}, more than ${retain} waiting`));
      });
      schedule(group);
    }
    return groups;
  };

  /** Deliver the group's head message once, and say what became of it. */
  const deliverHead = async (group: Group, retryAt: "now" | "later"): Promise<"done" | "retry" | "idle"> => {
    const head = group.pending[0];
    const member = group.members[group.next % Math.max(group.members.length, 1)];
    if (head === undefined || member === undefined) return "idle";
    group.next++;
    deliveries++;
    let disposition: Disposition;
    try {
      disposition = await member(head.message);
    } catch (error) {
      onError(error);
      disposition = "retry";
    }
    const { message } = head;
    if (disposition === "retry" && message.attempt < maxAttempts) {
      // In place: nothing after it reaches the group first, so per-key order holds.
      group.pending[0] = { ...head, message: { ...message, attempt: message.attempt + 1 } };
      if (retryAt === "later") await wait(retryDelay(message.attempt));
      return "retry";
    }
    group.pending.shift();
    if (disposition !== "ack") deadLetter(message, disposition === "dead-letter" ? "rejected" : `failed ${maxAttempts} deliveries`);
    settle(head, true);
    return "done";
  };

  /** Start the group's delivery loop on a later tick, never inside the publisher's call. */
  const schedule = (group: Group) => {
    if (delivery === "queued" || group.running !== undefined || closed) return;
    group.running = (async () => {
      await wait(0);
      while (!closed && (await deliverHead(group, "later")) !== "idle");
    })().finally(() => {
      group.running = undefined;
      if (!closed && group.pending.length > 0 && group.members.length > 0) schedule(group);
    });
  };

  const allGroups = () => [...topics.values()].flatMap((topic) => [...topic.groups.values()]);
  const busy = () => allGroups().filter((group) => group.running !== undefined || (group.pending.length > 0 && group.members.length > 0));

  const drain = async (): Promise<number> => {
    const before = deliveries;
    if (closed) return 0;
    for (let groups = busy(); groups.length > 0; groups = busy()) {
      if (delivery === "queued") {
        for (const group of groups) while ((await deliverHead(group, "now")) !== "idle");
      } else {
        groups.forEach(schedule);
        await Promise.all(groups.map((group) => group.running));
      }
    }
    return deliveries - before;
  };

  const unavailable = (message: string) => Result.err(new DependencyUnavailable({ dependency: "in-memory transport", message: `in-memory transport: ${message}` }));

  return {
    get published() {
      return [...published];
    },
    get deadLetters() {
      return [...deadLetters];
    },

    ping: async () => (closed ? unavailable("closed") : Result.ok(undefined)),

    publish: async (topicName, outgoing: OutgoingMessage) => {
      if (closed) return unavailable(`closed, cannot publish to ${topicName}`);
      let message: Message;
      try {
        message = { id: outgoing.id, key: outgoing.key ?? outgoing.id, topic: topicName, body: asJson(outgoing.body), headers: asJson({ ...outgoing.headers }), attempt: 1 };
      } catch {
        // A broker would fail to serialize it too; nothing was sent.
        return unavailable(`the body for ${topicName} is not JSON`);
      }
      keepLast(published, message);
      if (delivery !== "acknowledged") {
        enqueue(message);
        return Result.ok(undefined);
      }
      // A group nobody listens to cannot acknowledge: it keeps the message, and the publisher hears
      // at once that it is not done — rather than at its timeout, or never.
      const absent = [...(topics.get(topicName)?.groups.values() ?? [])].filter((group) => group.members.length === 0).map((group) => group.name);
      if (absent.length > 0) {
        enqueue(message);
        return unavailable(`no subscriber in group ${absent.join(", ")} for ${topicName}; kept for it`);
      }
      let outstanding = 0;
      let failed = false;
      let done: () => void = () => {};
      const acknowledged = new Promise<void>((resolve) => (done = resolve));
      outstanding = enqueue(message, (handled) => {
        failed ||= !handled;
        if (--outstanding === 0) done();
      });
      if (outstanding === 0) return Result.ok(undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), ackTimeoutMs)));
      const outcome = await Promise.race([acknowledged, timedOut]);
      clearTimeout(timer);
      if (outcome === "timeout") return unavailable(`no acknowledgement for ${message.id} on ${topicName} within ${ackTimeoutMs} ms`);
      return failed ? unavailable(`${message.id} on ${topicName} was not acknowledged before its consumers stopped`) : Result.ok(undefined);
    },

    subscribe: async (topicName, handler, subscribeOptions = {}) => {
      if (closed) throw new Error(`in-memory transport: closed, cannot subscribe to ${topicName}`);
      const topic = topicOf(topicName);
      const name = subscribeOptions.group ?? "default";
      let group = topic.groups.get(name);
      if (group === undefined) {
        group = { name, members: [], next: 0, pending: topic.log.map((message) => ({ message })) };
        topic.groups.set(name, group);
      }
      const joined = group;
      joined.members.push(handler);
      schedule(joined);
      return {
        close: async () => {
          const index = joined.members.indexOf(handler);
          if (index === -1) return;
          joined.members.splice(index, 1);
          if (joined.members.length > 0) return;
          await joined.running;
          // Publishers waiting on this group learn now, rather than at their timeout.
          for (const pending of joined.pending) settle(pending, false);
        },
      } satisfies Subscription;
    },

    drain,

    close: async () => {
      if (closed) return;
      if (delivery !== "queued") await drain();
      closed = true;
      const groups = allGroups();
      await Promise.all(groups.map((group) => group.running));
      for (const group of groups) for (const pending of group.pending) settle(pending, false);
    },
  };
}
