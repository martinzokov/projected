/**
 * Tracing, as a port. The application layer creates spans and moves trace context through
 * messages without knowing which tracing system is underneath: `@projected/opentelemetry`
 * implements this for OpenTelemetry, and {@link noTelemetry} is the default.
 */

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";
export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue | undefined>>;

/** The span currently being recorded. */
export interface Span {
  setAttributes(attributes: Attributes): void;
  /** Mark the span as failed. Expected business outcomes are not failures. */
  fail(message: string): void;
}

export interface SpanOptions {
  readonly kind?: SpanKind;
  readonly attributes?: Attributes;
}

export interface Telemetry {
  /** Run `work` inside a new span, a child of the current one. The span ends when `work` settles. */
  span<T>(name: string, options: SpanOptions, work: (span: Span) => Promise<T>): Promise<T>;
  /** Write the current trace context into `carrier` (W3C `traceparent`, `tracestate`). */
  inject(carrier: Record<string, string>): void;
  /** Run `work` as a continuation of the trace whose context is in `carrier`. */
  continueFrom<T>(carrier: Readonly<Record<string, string>> | undefined, work: () => Promise<T>): Promise<T>;
}

const noSpan: Span = { setAttributes: () => undefined, fail: () => undefined };

/** Telemetry that records nothing. */
export const noTelemetry: Telemetry = {
  span: (_name, _options, work) => work(noSpan),
  inject: () => undefined,
  continueFrom: (_carrier, work) => work(),
};

/** The current trace context as a carrier, or `undefined` when there is none. */
export function currentTrace(telemetry: Telemetry): Readonly<Record<string, string>> | undefined {
  const carrier: Record<string, string> = {};
  telemetry.inject(carrier);
  return Object.keys(carrier).length === 0 ? undefined : carrier;
}

/** Only the W3C trace-context entries of a header or metadata record. */
export function traceCarrier(source: Readonly<Record<string, unknown>> | undefined): Record<string, string> | undefined {
  if (source === undefined) return undefined;
  const carrier: Record<string, string> = {};
  for (const key of ["traceparent", "tracestate"]) {
    const value = source[key];
    if (typeof value === "string") carrier[key] = value;
  }
  return Object.keys(carrier).length === 0 ? undefined : carrier;
}
