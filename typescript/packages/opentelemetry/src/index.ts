/**
 * @projected/opentelemetry — the Telemetry port on the OpenTelemetry API. Import it from the
 * composition root and pass it to `createApplication({ telemetry })`, repositories and clients.
 *
 * It uses the global tracer and meter providers, context manager and propagator, so configure
 * the OpenTelemetry SDK first (e.g. `@opentelemetry/sdk-node`); without an SDK every call is a
 * no-op.
 */
import type { Attributes as ProjectedAttributes, Span, SpanKind, Telemetry } from "@projected/application";
import {
  context,
  metrics,
  propagation,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type Gauge,
  type Histogram,
  type Meter,
  type Tracer,
} from "@opentelemetry/api";

const KINDS: Record<SpanKind, OtelSpanKind> = {
  internal: OtelSpanKind.INTERNAL,
  server: OtelSpanKind.SERVER,
  client: OtelSpanKind.CLIENT,
  producer: OtelSpanKind.PRODUCER,
  consumer: OtelSpanKind.CONSUMER,
};

const defined = (attributes: ProjectedAttributes | undefined): Attributes =>
  Object.fromEntries(Object.entries(attributes ?? {}).filter(([, value]) => value !== undefined)) as Attributes;

export interface OpenTelemetryOptions {
  /** Defaults to the global tracer named `projected`. */
  readonly tracer?: Tracer;
  /** Defaults to the global meter named `projected`. */
  readonly meter?: Meter;
}

/** {@link Telemetry} backed by OpenTelemetry. */
export function openTelemetry(options: OpenTelemetryOptions = {}): Telemetry {
  const tracer = () => options.tracer ?? trace.getTracer("projected");
  const meter = () => options.meter ?? metrics.getMeter("projected");
  // Instruments are created once per name: the SDK keeps their aggregation.
  const counters = new Map<string, Counter>();
  const histograms = new Map<string, Histogram>();
  const gauges = new Map<string, Gauge>();
  const instrument = <I>(cache: Map<string, I>, name: string, create: (name: string) => I): I => {
    const existing = cache.get(name);
    if (existing !== undefined) return existing;
    const created = create(name);
    cache.set(name, created);
    return created;
  };

  return {
    span: <T>(name: string, spanOptions: { kind?: SpanKind; attributes?: ProjectedAttributes }, work: (span: Span) => Promise<T>) =>
      tracer().startActiveSpan(
        name,
        { kind: KINDS[spanOptions.kind ?? "internal"], attributes: defined(spanOptions.attributes) },
        async (span): Promise<T> => {
          try {
            return await work({
              setAttributes: (attributes) => span.setAttributes(defined(attributes)),
              fail: (message) => span.setStatus({ code: SpanStatusCode.ERROR, message }),
            });
          } catch (error) {
            // A throw here is a defect; record it and let it propagate unchanged.
            span.recordException(error instanceof Error ? error : String(error));
            span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
            throw error;
          } finally {
            span.end();
          }
        },
      ),
    inject: (carrier) => propagation.inject(context.active(), carrier),
    continueFrom: (carrier, work) =>
      carrier === undefined ? work() : context.with(propagation.extract(context.active(), carrier), work),
    count: (name, value, attributes) => instrument(counters, name, (n) => meter().createCounter(n)).add(value, defined(attributes)),
    record: (name, value, attributes) => instrument(histograms, name, (n) => meter().createHistogram(n)).record(value, defined(attributes)),
    gauge: (name, value, attributes) => instrument(gauges, name, (n) => meter().createGauge(n)).record(value, defined(attributes)),
  };
}
