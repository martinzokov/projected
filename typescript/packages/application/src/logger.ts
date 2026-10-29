/**
 * Logs, as a port. A record is a message and fields, never a string with values spliced in, so
 * that whatever collects the logs can search them. `jsonLogger` in `@projected/runtime` writes one
 * JSON line per record; {@link noLogger} is the default.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every record: `log.child({ component: "relay" })`. */
  child(fields: LogFields): Logger;
}

/** A logger that writes nothing. */
export const noLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noLogger,
};
