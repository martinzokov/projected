/**
 * @projected/messaging — asynchronous driving and driven adapters. Import it only from
 * `src/infrastructure/**`.
 */
export {
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
} from "./transport.js";
export { CommandMessage, commandQueue, consumeCommands, type CommandQueueOptions, type ConsumeCommandsOptions } from "./commands.js";
export { EventMessage, consumeEvents, eventRelay, type ConsumeEventsOptions, type EventRelayOptions } from "./events.js";
