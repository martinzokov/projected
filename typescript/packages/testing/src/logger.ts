import type { LogFields, LogLevel, Logger } from "@projected/application";

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  /** The record's fields, with those of the child loggers it came through. */
  readonly fields: LogFields;
}

/** A {@link Logger} that keeps every record, children's included, for assertions. */
export interface RecordingLogger extends Logger {
  readonly records: readonly LogRecord[];
}

export function recordingLogger(): RecordingLogger {
  const records: LogRecord[] = [];
  const logger = (base: LogFields): Logger => {
    const keep = (level: LogLevel) => (message: string, fields: LogFields = {}) => void records.push({ level, message, fields: { ...base, ...fields } });
    return { debug: keep("debug"), info: keep("info"), warn: keep("warn"), error: keep("error"), child: (fields) => logger({ ...base, ...fields }) };
  };
  return { ...logger({}), records };
}
