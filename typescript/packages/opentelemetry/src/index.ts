/**
 * @projected/opentelemetry — the Telemetry port on the OpenTelemetry API. Import it from the
 * composition root and pass it to `createApplication({ telemetry })`, repositories and clients.
 *
 * It uses the global tracer provider, context manager and propagator, so configure the
 * OpenTelemetry SDK first (e.g. `@opentelemetry/sdk-node`); without an SDK every call is a no-op.
 */
import type { Attributes as ProjectedAttributes, Span, SpanKind, Telemetry } from "@projected/application";
import {
  context,
  propagation,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
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
}

/** {@link Telemetry} backed by OpenTelemetry. */
export function openTelemetry(options: OpenTelemetryOptions = {}): Telemetry {
  const tracer = () => options.tracer ?? trace.getTracer("projected");

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
  };
}
