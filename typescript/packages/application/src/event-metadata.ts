import type { EventMetadata, ExecutionContext } from "./ports.js";

/**
 * What every recorded event records about its cause: the flow it belongs to, the message that
 * caused it, who sent that message, and the trace to continue in whatever reacts to it.
 */
export function eventMetadataFrom(context: ExecutionContext | undefined): EventMetadata {
  if (context === undefined) return {};
  const { correlationId, messageId, principal, trace } = context.metadata;
  return {
    correlationId,
    causationId: messageId,
    ...(principal === undefined ? {} : { principalId: principal.id }),
    ...(trace === undefined ? {} : { trace }),
  };
}
