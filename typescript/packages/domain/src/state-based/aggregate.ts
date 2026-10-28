import { Result, TaggedError, panic } from "better-result";
import type { z } from "zod";
import type { AnyEventDefinition, EventMigration, EventOfDefinition, SerializedEvent } from "../event.js";

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;

/** A stored state document, as it comes out of a state store. */
export interface SerializedState {
  readonly schemaVersion: number;
  readonly data: unknown;
}

/** Stored state could not be read with the current definition. Indicates a defect. */
export class StateDecodingFailed extends TaggedError("StateDecodingFailed")<{
  aggregate: string;
  schemaVersion: number;
  message: string;
  issues?: readonly z.core.$ZodIssue[];
}> {}

/**
 * A state-stored aggregate: a consistency boundary whose current state is persisted as one
 * document, guarded by optimistic concurrency. Decisions compute the next state directly, and
 * may emit domain events alongside it for projections and other services.
 */
export interface AggregateDefinition<
  Name extends string = string,
  S extends z.ZodType = z.ZodType,
  Events extends readonly AnyEventDefinition[] = readonly AnyEventDefinition[],
> {
  /** Storage category. An aggregate is stored under `<name>-<id>`, so the name never contains a dash. */
  readonly name: Name;
  /** Schema of the stored state. JSON-compatible: it is persisted. */
  readonly schema: S;
  /** Current schema version. Bump it when the state's shape changes and add a migration. */
  readonly version: number;
  readonly migrations: readonly EventMigration[];
  /** Domain events decisions may emit. Empty when the aggregate emits none. */
  readonly events: Events;
  /** The storage key of the aggregate with this id. */
  key(id: string): string;
  /** Serialize at the current version. A state the schema rejects is a defect and panics. */
  encode(state: z.output<S>): SerializedState;
  /** Validate stored state, migrating it from older versions when needed. */
  decode(serialized: SerializedState): Result<z.output<S>, StateDecodingFailed>;
  encodeEvent(event: EventOfDefinition<Events[number]>): SerializedEvent;
}

/** Any aggregate definition. */
// `any` is deliberate: the schema is invariant in `AggregateDefinition`, so concrete aggregates
// would not be assignable to `AggregateDefinition<string, z.ZodType>`. `StateOf` recovers the type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAggregate = AggregateDefinition<string, any, readonly AnyEventDefinition[]>;

/** The state type of an aggregate. */
export type StateOf<A extends AnyAggregate> = z.output<A["schema"]>;

/** The union of event values an aggregate can emit. */
export type EventOf<A extends AnyAggregate> = EventOfDefinition<A["events"][number]>;

/** What a decision does to an aggregate. */
export type Change<A extends AnyAggregate> =
  /** Store this as the new state, emitting these events. */
  | { readonly kind: "change"; readonly state: StateOf<A>; readonly events: ReadonlyArray<EventOf<A>> }
  /** Delete the aggregate, emitting these events. */
  | { readonly kind: "remove"; readonly events: ReadonlyArray<EventOf<A>> }
  /** Accepted, but already true: store nothing. */
  | { readonly kind: "none" };

/**
 * The outcome of a decision function: the change to make, or the business rule that was broken.
 * Build changes with {@link changeTo}, {@link remove} and {@link noChange}.
 */
export type Decision<A extends AnyAggregate, E = never> = Result<Change<A>, E>;

/** Store `state` as the aggregate's new state, emitting `events`. */
export function changeTo<S, const Events extends readonly unknown[]>(state: S, ...events: Events) {
  return { kind: "change", state, events } as const;
}

/** Delete the aggregate, emitting `events`. */
export function remove<const Events extends readonly unknown[]>(...events: Events) {
  return { kind: "remove", events } as const;
}

/** Accept the request without changing anything — an idempotent no-op. */
export function noChange() {
  return { kind: "none" } as const;
}

export interface DefineAggregateOptions<Name extends string, S extends z.ZodType, Events extends readonly AnyEventDefinition[]> {
  readonly name: Name;
  readonly schema: S;
  /** Current schema version. Defaults to 1. */
  readonly version?: number;
  /** Migrations from every older version: `[migration(1, V1, (v1) => ...)]`. */
  readonly migrations?: readonly EventMigration[];
  /** Domain events decisions may emit. */
  readonly events?: Events;
}

/**
 * Define a state-stored aggregate.
 *
 * ```ts
 * export const Student = defineAggregate({
 *   name: "student",
 *   schema: z.object({ firstname: z.string(), lastname: z.string(), status: z.enum(["enlisted", "withdrawn"]) }),
 *   events: [StudentEnlisted, StudentWithdrawn],
 * });
 * export type StudentState = StateOf<typeof Student>;
 * ```
 *
 * Decisions are plain functions next to it:
 * `(state: StudentState | undefined, input) => Decision<typeof Student, Errors>`.
 */
export function defineAggregate<
  const Name extends string,
  S extends z.ZodType,
  const Events extends readonly AnyEventDefinition[] = readonly [],
>(options: DefineAggregateOptions<Name, S, Events>): AggregateDefinition<Name, S, Events> {
  if (!CAMEL_CASE.test(options.name)) {
    panic(`defineAggregate: name "${options.name}" must be camelCase with no dashes, e.g. "student"`);
  }
  const version = options.version ?? 1;
  const migrations = [...(options.migrations ?? [])].sort((a, b) => a.from - b.from);
  if (migrations.length !== version - 1 || migrations.some((m, index) => m.from !== index + 1)) {
    panic(`defineAggregate("${options.name}"): version ${version} needs one migration from each of versions 1..${version - 1}`);
  }
  const events = (options.events ?? []) as unknown as Events;
  const byType = new Map<string, AnyEventDefinition>();
  for (const definition of events) {
    if (byType.has(definition.type)) panic(`defineAggregate("${options.name}"): event ${definition.type} is listed twice`);
    byType.set(definition.type, definition);
  }

  type State = z.output<S>;
  const failed = (schemaVersion: number, message: string, issues?: readonly z.core.$ZodIssue[]) =>
    new StateDecodingFailed({
      aggregate: options.name,
      schemaVersion,
      message: `Cannot decode ${options.name} state v${schemaVersion}: ${message}`,
      ...(issues === undefined ? {} : { issues }),
    });

  return {
    name: options.name,
    schema: options.schema,
    version,
    migrations,
    events,
    key: (id) => `${options.name}-${id}`,
    encode: (state) => {
      // Refinements (`.min(1)`, formats) are not visible to the type checker; catch a decision that
      // breaks them here, before it is stored and every later load of the aggregate fails.
      const parsed = options.schema.safeParse(state);
      if (!parsed.success) {
        return panic(`${options.name}: a decision produced an invalid state: ${parsed.error.message}`, parsed.error);
      }
      return { schemaVersion: version, data: state };
    },
    decode: (serialized): Result<State, StateDecodingFailed> => {
      if (serialized.schemaVersion > version) {
        return Result.err(failed(serialized.schemaVersion, `newer than the known version ${version}`));
      }
      let data = serialized.data;
      for (let at = serialized.schemaVersion; at < version; at++) {
        const step = migrations[at - 1];
        if (step === undefined) return Result.err(failed(serialized.schemaVersion, `no migration from version ${at}`));
        const parsed = step.schema.safeParse(data);
        if (!parsed.success) return Result.err(failed(serialized.schemaVersion, `invalid v${at} state`, parsed.error.issues));
        data = step.migrate(parsed.data);
      }
      const parsed = options.schema.safeParse(data);
      return parsed.success
        ? Result.ok(parsed.data as State)
        : Result.err(failed(serialized.schemaVersion, "invalid state", parsed.error.issues));
    },
    encodeEvent: (event) => {
      const { type, data } = event as { type: string; data: unknown };
      const definition = byType.get(type);
      if (definition === undefined) return panic(`${options.name}: cannot emit unlisted event ${type}`);
      return { type, schemaVersion: definition.version, data };
    },
  };
}
