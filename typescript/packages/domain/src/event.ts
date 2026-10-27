import { Result, TaggedError, panic } from "better-result";
import type { z } from "zod";

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;

/** A domain event: a fact that happened, named in the past tense. Immutable. */
export interface DomainEvent<Type extends string = string, Data = unknown> {
  readonly type: Type;
  readonly data: Data;
}

/** Upgrades the stored data of an older event version to the next version. */
export interface EventMigration {
  /** The version this migration reads. It produces data for version `from + 1`. */
  readonly from: number;
  readonly schema: z.ZodType;
  readonly migrate: (data: unknown) => unknown;
}

/**
 * Declares how to read version `from` of an event and turn it into the shape of version `from + 1`.
 * The output is validated against the next version's schema when the event is read.
 */
export function migration<S extends z.ZodType>(
  from: number,
  schema: S,
  migrate: (data: z.output<S>) => unknown,
): EventMigration {
  return { from, schema, migrate: (data) => migrate(data as z.output<S>) };
}

/** A stored, serialized event as it comes out of an event store. */
export interface SerializedEvent {
  readonly type: string;
  readonly schemaVersion: number;
  readonly data: unknown;
}

/** Stored event data could not be read with the current event definitions. Indicates a defect. */
export class EventDecodingFailed extends TaggedError("EventDecodingFailed")<{
  type: string;
  schemaVersion: number;
  message: string;
  issues?: readonly z.core.$ZodIssue[];
}> {}

/** The callable definition produced by {@link defineEvent}. Call it to create an event. */
export interface EventDefinition<Type extends string = string, S extends z.ZodType = z.ZodType> {
  (data: z.output<S>): DomainEvent<Type, z.output<S>>;
  readonly type: Type;
  /** Current schema version. Events are always written at this version. */
  readonly version: number;
  readonly schema: S;
  readonly description: string | undefined;
  readonly migrations: readonly EventMigration[];
  /** Type guard over any event. */
  is(event: DomainEvent): event is DomainEvent<Type, z.output<S>>;
  /** Serialize at the current version. */
  encode(event: DomainEvent<Type, z.output<S>>): SerializedEvent;
  /** Validate stored data, migrating it from older versions when needed. */
  decode(serialized: SerializedEvent): Result<DomainEvent<Type, z.output<S>>, EventDecodingFailed>;
}

/** Any definition produced by {@link defineEvent}. */
// `any` is deliberate: the call signature makes `EventDefinition` invariant in its schema, so
// concrete definitions would not be assignable to `EventDefinition<string, z.ZodType>`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEventDefinition = EventDefinition<string, any>;

/** The event value created by an event definition. */
export type EventOfDefinition<D extends AnyEventDefinition> = D extends EventDefinition<infer T, infer S>
  ? DomainEvent<T, z.output<S>>
  : never;

export interface DefineEventOptions<S extends z.ZodType> {
  /** Schema of the event's data. Must be JSON-compatible: events are persisted. */
  readonly schema: S;
  /** Current schema version. Bump it when the shape changes and add a migration. Defaults to 1. */
  readonly version?: number;
  /** Migrations from every older version, one per version: `[migration(1, V1, ...), migration(2, V2, ...)]`. */
  readonly migrations?: readonly EventMigration[];
  readonly description?: string;
}

/**
 * Define a domain event.
 *
 * ```ts
 * export const StudentEnlisted = defineEvent("StudentEnlisted", {
 *   schema: z.object({ studentId: z.string(), joiningDate: z.iso.date() }),
 * });
 *
 * const event = StudentEnlisted({ studentId: "s-1", joiningDate: "2023-09-22" });
 * // { type: "StudentEnlisted", data: { studentId: "s-1", joiningDate: "2023-09-22" } }
 * ```
 *
 * Events are persisted forever. Never change a published version's schema: bump `version`
 * and add a {@link migration} from the previous one.
 */
export function defineEvent<const Type extends string, S extends z.ZodType>(
  type: Type,
  options: DefineEventOptions<S>,
): EventDefinition<Type, S> {
  if (!PASCAL_CASE.test(type)) {
    panic(`defineEvent: type "${type}" must be PascalCase and in the past tense, e.g. "StudentEnlisted"`);
  }
  const version = options.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    panic(`defineEvent("${type}"): version must be a positive integer, got ${version}`);
  }
  const migrations = [...(options.migrations ?? [])].sort((a, b) => a.from - b.from);
  migrations.forEach((m, index) => {
    if (m.from !== index + 1) {
      panic(`defineEvent("${type}"): expected a migration from version ${index + 1}, found one from ${m.from}`);
    }
  });
  if (migrations.length !== version - 1) {
    panic(`defineEvent("${type}"): version ${version} needs ${version - 1} migration(s), found ${migrations.length}`);
  }

  type Data = z.output<S>;
  const decodingFailed = (schemaVersion: number, message: string, issues?: readonly z.core.$ZodIssue[]) =>
    new EventDecodingFailed({
      type,
      schemaVersion,
      message: `Cannot decode ${type} v${schemaVersion}: ${message}`,
      ...(issues === undefined ? {} : { issues }),
    });

  const decode = (serialized: SerializedEvent): Result<DomainEvent<Type, Data>, EventDecodingFailed> => {
    if (serialized.type !== type) {
      return Result.err(decodingFailed(serialized.schemaVersion, `not a ${type} event: ${serialized.type}`));
    }
    let data = serialized.data;
    for (let at = serialized.schemaVersion; at < version; at++) {
      const step = migrations[at - 1];
      if (step === undefined) {
        return Result.err(decodingFailed(serialized.schemaVersion, `no migration from version ${at}`));
      }
      const parsed = step.schema.safeParse(data);
      if (!parsed.success) {
        return Result.err(decodingFailed(serialized.schemaVersion, `invalid v${at} data`, parsed.error.issues));
      }
      data = step.migrate(parsed.data);
    }
    if (serialized.schemaVersion > version) {
      return Result.err(decodingFailed(serialized.schemaVersion, `newer than the known version ${version}`));
    }
    const parsed = options.schema.safeParse(data);
    if (!parsed.success) {
      return Result.err(decodingFailed(serialized.schemaVersion, "invalid data", parsed.error.issues));
    }
    return Result.ok({ type, data: parsed.data });
  };

  const create = (data: Data): DomainEvent<Type, Data> => ({ type, data });
  return Object.assign(create, {
    type,
    version,
    schema: options.schema,
    description: options.description,
    migrations,
    is: (event: DomainEvent): event is DomainEvent<Type, Data> => event.type === type,
    encode: (event: DomainEvent<Type, Data>): SerializedEvent => ({ type, schemaVersion: version, data: event.data }),
    decode,
  });
}
