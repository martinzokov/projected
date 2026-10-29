import { currentTrace, type Clock, type LogFields, type LogLevel, type Logger, type Telemetry } from "@projected/application";

export interface JsonLoggerOptions {
  /** Records below this level are dropped. Defaults to `"info"`. */
  readonly level?: LogLevel;
  /** Added to every record: `{ service: "school" }`. */
  readonly fields?: LogFields;
  /** Adds the active span's `trace_id` and `span_id`, so that a record leads to its trace. */
  readonly telemetry?: Telemetry;
  /** Defaults to the system clock. */
  readonly clock?: Clock;
  /** Where each line goes. Defaults to standard output. */
  readonly write?: (line: string) => void;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** A setting such as LOG_LEVEL as a level: `debug`, `info`, `warn` or `error`; anything else is `info`. */
export const logLevel = (value: string | undefined): LogLevel => (value !== undefined && Object.hasOwn(RANK, value) ? (value as LogLevel) : "info");

const OWN = new Set(["name", "message", "stack", "cause", "_tag"]);

/** An error as fields that survive JSON: its tag, message, own data (`operation`, `dependency`), stack, and its cause's. */
function describeError(error: Error, depth = 0): Record<string, unknown> {
  const tag = (error as { _tag?: unknown })._tag;
  const cause = error.cause;
  const data = Object.fromEntries(Object.entries(error).filter(([key, value]) => !OWN.has(key) && typeof value !== "function"));
  return {
    ...(typeof tag === "string" ? { type: tag } : { type: error.name }),
    message: error.message,
    ...data,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(cause instanceof Error && depth < 3 ? { cause: describeError(cause, depth + 1) } : {}),
  };
}

/** `traceparent` is `version-traceid-spanid-flags`. */
function traceIds(telemetry: Telemetry | undefined): Record<string, string> {
  const traceparent = telemetry === undefined ? undefined : currentTrace(telemetry)?.["traceparent"];
  const [, traceId, spanId] = traceparent?.split("-") ?? [];
  return traceId === undefined || spanId === undefined ? {} : { trace_id: traceId, span_id: spanId };
}

/**
 * A {@link Logger} that writes one JSON object per line — `time`, `level`, `message`, the
 * logger's fields, the record's fields — the shape log collectors read without configuration.
 * Errors become `{ type, message, stack, cause }`.
 */
export function jsonLogger(options: JsonLoggerOptions = {}): Logger {
  const minimum = RANK[options.level ?? "info"];
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = () => (options.clock?.now() ?? new Date()).toISOString();

  const logger = (base: LogFields): Logger => {
    const emit = (level: LogLevel) => (message: string, fields: LogFields = {}) => {
      if (RANK[level] < minimum) return;
      const record: Record<string, unknown> = { time: now(), level, message, ...base, ...traceIds(options.telemetry) };
      for (const [key, value] of Object.entries(fields)) record[key] = value instanceof Error ? describeError(value) : value;
      let line: string;
      try {
        line = JSON.stringify(record);
      } catch {
        line = JSON.stringify({ time: record["time"], level, message, unserializable: Object.keys(fields) });
      }
      write(line);
    };
    return {
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      child: (fields) => logger({ ...base, ...fields }),
    };
  };
  return logger(options.fields ?? {});
}
