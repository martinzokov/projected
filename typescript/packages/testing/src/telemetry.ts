import type { Attributes, SpanKind, Telemetry } from "@projected/application";
import { AsyncLocalStorage } from "node:async_hooks";

export interface RecordedSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly attributes: Record<string, unknown>;
  readonly failures: string[];
}

export interface RecordingTelemetry extends Telemetry {
  readonly spans: readonly RecordedSpan[];
  /** Spans whose name matches. */
  named(name: string | RegExp): RecordedSpan[];
}

/**
 * Telemetry that records spans in memory and propagates W3C `traceparent` headers, for asserting
 * on tracing without an OpenTelemetry SDK.
 */
export function recordingTelemetry(): RecordingTelemetry {
  const active = new AsyncLocalStorage<{ traceId: string; spanId: string }>();
  const spans: RecordedSpan[] = [];
  let counter = 0;
  const id = (length: number) => (++counter).toString(16).padStart(length, "0");

  return {
    spans,
    named: (name) => spans.filter((span) => (typeof name === "string" ? span.name === name : name.test(span.name))),
    span: (name, options, work) => {
      const parent = active.getStore();
      const record: RecordedSpan = {
        name,
        kind: options.kind ?? "internal",
        traceId: parent?.traceId ?? id(32),
        spanId: id(16),
        parentSpanId: parent?.spanId,
        attributes: {},
        failures: [],
      };
      const setAttributes = (attributes: Attributes) => {
        for (const [key, value] of Object.entries(attributes)) if (value !== undefined) record.attributes[key] = value;
      };
      setAttributes(options.attributes ?? {});
      spans.push(record);
      return active.run({ traceId: record.traceId, spanId: record.spanId }, () =>
        work({ setAttributes, fail: (message) => record.failures.push(message) }),
      );
    },
    inject: (carrier) => {
      const current = active.getStore();
      if (current !== undefined) carrier.traceparent = `00-${current.traceId}-${current.spanId}-01`;
    },
    continueFrom: (carrier, work) => {
      const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(carrier?.traceparent ?? "");
      return match === null ? work() : active.run({ traceId: match[1] ?? "", spanId: match[2] ?? "" }, work);
    },
  };
}
