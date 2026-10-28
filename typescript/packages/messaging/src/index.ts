/**
 * @projected/messaging — asynchronous driving and driven adapters. Import it only from
 * `src/infrastructure/**`.
 */
export {
  DEAD_LETTER_REASON_HEADER,
  REPLAY_HEADER,
  deadLetterTopic,
  inMemoryTransport,
  type Disposition,
  type InMemoryTransport,
  type InMemoryTransportOptions,
  type Message,
  type MessageTransport,
  type OutgoingMessage,
  type SubscribeOptions,
  type Subscription,
  transportReadiness,
} from "./transport.js";
export { CommandMessage, commandQueue, consumeCommands, type CommandQueueOptions, type ConsumeCommandsOptions } from "./commands.js";
export { EventMessage, consumeEvents, eventRelay, type ConsumeEventsOptions, type EventRelayOptions } from "./events.js";
export { deadLetterReplay, type DeadLetterReplayOptions } from "./replay.js";
export { sleep, withTimeout } from "./timing.js";
