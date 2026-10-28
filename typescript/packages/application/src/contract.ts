import { assertJsonCompatible, panic, z, type AnyBusinessErrorClass } from "@projected/domain";
import { KEBAB_CASE } from "./naming.js";

export type OperationKind = "command" | "query";

/**
 * Who may run an operation:
 * - `"public"` — anyone, including anonymous callers
 * - `"authenticated"` — any authenticated principal
 * - `{ permissions: [...] }` — a principal holding every listed permission
 *
 * Finer rules ("only the student themselves") are business rules: check
 * `context.metadata.principal` in the handler and return a declared business error.
 */
export type Access = "public" | "authenticated" | { readonly permissions: readonly string[] };

/**
 * A command or query: one business operation, at one version, with its input, output and the
 * business errors it may return. Each `(type, version)` is its own API and never changes once
 * published — evolve by adding a new version.
 */
export interface OperationContract<
  Kind extends OperationKind = OperationKind,
  Type extends string = string,
  Version extends number = number,
  In extends z.ZodType = z.ZodType,
  Out extends z.ZodType = z.ZodType,
  Errors extends readonly AnyBusinessErrorClass[] = readonly AnyBusinessErrorClass[],
> {
  readonly kind: Kind;
  /** Business operation name in kebab-case: `enlist-student`, not `create-student`. */
  readonly type: Type;
  readonly version: Version;
  /** `type@version` — identifies the contract in handler maps and lock files. */
  readonly key: `${Type}@${Version}`;
  readonly summary: string | undefined;
  readonly description: string | undefined;
  readonly deprecated: boolean;
  readonly input: In;
  readonly output: Out;
  /** Business errors the operation may return. A handler cannot return any other business error. */
  readonly errors: Errors;
  /** Who may run it. `undefined` inherits the service default given to `defineContracts`. */
  readonly access: Access | undefined;
}

export type CommandContract<
  Type extends string = string,
  Version extends number = number,
  In extends z.ZodType = z.ZodType,
  Out extends z.ZodType = z.ZodType,
  Errors extends readonly AnyBusinessErrorClass[] = readonly AnyBusinessErrorClass[],
> = OperationContract<"command", Type, Version, In, Out, Errors>;

export type QueryContract<
  Type extends string = string,
  Version extends number = number,
  In extends z.ZodType = z.ZodType,
  Out extends z.ZodType = z.ZodType,
  Errors extends readonly AnyBusinessErrorClass[] = readonly AnyBusinessErrorClass[],
> = OperationContract<"query", Type, Version, In, Out, Errors>;

export type AnyOperationContract = OperationContract;
export type AnyCommandContract = CommandContract;
export type AnyQueryContract = QueryContract;

/** What a handler receives: the input after validation. */
export type InputOf<C extends AnyOperationContract> = z.output<C["input"]>;
/** What a caller sends. */
export type RequestOf<C extends AnyOperationContract> = z.input<C["input"]>;
/** What a handler returns and a caller receives. */
export type OutputOf<C extends AnyOperationContract> = z.output<C["output"]>;
/** The union of business errors the operation declares. */
export type ErrorOf<C extends AnyOperationContract> = InstanceType<C["errors"][number]>;

export interface DefineOperationOptions<
  Type extends string,
  Version extends number,
  In extends z.ZodType,
  Out extends z.ZodType,
  Errors extends readonly AnyBusinessErrorClass[],
> {
  readonly type: Type;
  /** Positive integer. Defaults to 1. */
  readonly version?: Version;
  readonly summary?: string;
  readonly description?: string;
  readonly deprecated?: boolean;
  readonly input: In;
  readonly output: Out;
  readonly errors?: Errors;
  /** Overrides the service default from `defineContracts`. */
  readonly access?: Access;
}

function defineOperation<
  Kind extends OperationKind,
  Type extends string,
  Version extends number,
  In extends z.ZodType,
  Out extends z.ZodType,
  Errors extends readonly AnyBusinessErrorClass[],
>(
  kind: Kind,
  options: DefineOperationOptions<Type, Version, In, Out, Errors>,
): OperationContract<Kind, Type, Version, In, Out, Errors> {
  const { type } = options;
  const version = (options.version ?? 1) as Version;
  const label = `define${kind === "command" ? "Command" : "Query"}("${type}")`;
  if (!KEBAB_CASE.test(type)) {
    panic(`${label}: type must be kebab-case and name a business operation, e.g. "enlist-student"`);
  }
  if (!Number.isInteger(version) || version < 1) {
    panic(`${label}: version must be a positive integer, got ${version}`);
  }
  assertJsonCompatible(label, "input", options.input, "input");
  assertJsonCompatible(label, "output", options.output, "output");
  const errors = (options.errors ?? []) as unknown as Errors;
  const tags = new Set<string>();
  for (const error of errors) {
    if (tags.has(error.tag)) panic(`${label}: error ${error.tag} is listed twice`);
    tags.add(error.tag);
    assertJsonCompatible(label, `error ${error.tag}`, error.schema, "output");
  }
  return {
    kind,
    type,
    version,
    key: `${type}@${version}`,
    summary: options.summary,
    description: options.description,
    deprecated: options.deprecated ?? false,
    input: options.input,
    output: options.output,
    errors,
    access: options.access === undefined ? undefined : checkAccess(label, options.access),
  };
}

const PERMISSION = /^[a-z][a-z0-9-]*(:[a-z0-9-]+)*$/;

function checkAccess(label: string, access: Access): Access {
  if (access === "public" || access === "authenticated") return access;
  if (access.permissions.length === 0) panic(`${label}: { permissions: [] } grants nothing — use "authenticated"`);
  for (const permission of access.permissions) {
    if (!PERMISSION.test(permission)) panic(`${label}: permission "${permission}" must look like "students:enlist"`);
  }
  return { permissions: [...access.permissions] };
}

/**
 * Define a command: a request to change the system, named for the business intent.
 *
 * ```ts
 * export const EnlistStudent = defineCommand({
 *   type: "enlist-student",
 *   version: 1,
 *   input: z.object({ firstname: z.string(), lastname: z.string(), joiningDate: z.iso.date() }),
 *   output: z.object({ studentId: z.string() }),
 *   errors: [StudentAlreadyEnlisted],
 * });
 * ```
 *
 * Served at `POST /commands/enlist-student/version/1`.
 */
export function defineCommand<
  const Type extends string,
  In extends z.ZodType,
  Out extends z.ZodType,
  const Errors extends readonly AnyBusinessErrorClass[] = readonly [],
  const Version extends number = 1,
>(
  options: DefineOperationOptions<Type, Version, In, Out, Errors>,
): CommandContract<Type, Version, In, Out, Errors> {
  return defineOperation("command", options);
}

/**
 * Define a query: a question about the system's state, named for the business need.
 * Served at `POST /queries/<type>/version/<version>`.
 */
export function defineQuery<
  const Type extends string,
  In extends z.ZodType,
  Out extends z.ZodType,
  const Errors extends readonly AnyBusinessErrorClass[] = readonly [],
  const Version extends number = 1,
>(
  options: DefineOperationOptions<Type, Version, In, Out, Errors>,
): QueryContract<Type, Version, In, Out, Errors> {
  return defineOperation("query", options);
}

/** The full public surface of one service: its name and every command and query it offers. */
export interface Contracts<
  Commands extends readonly AnyCommandContract[] = readonly AnyCommandContract[],
  Queries extends readonly AnyQueryContract[] = readonly AnyQueryContract[],
> {
  readonly name: string;
  readonly description: string | undefined;
  readonly commands: Commands;
  readonly queries: Queries;
  /** The service default for operations that do not set their own `access`. */
  readonly access: Access;
  /** Look up a contract by kind, type and version. */
  find(kind: OperationKind, type: string, version: number): AnyOperationContract | undefined;
  /** The access rule in force for an operation of this service. */
  accessOf(contract: AnyOperationContract): Access;
}

export type AnyContracts = Contracts;

/** Every operation (command or query) in a contracts set. */
export type OperationsOf<C extends AnyContracts> = C["commands"][number] | C["queries"][number];
export type CommandsOf<C extends AnyContracts> = C["commands"][number];
export type QueriesOf<C extends AnyContracts> = C["queries"][number];

export interface DefineContractsOptions<
  Commands extends readonly AnyCommandContract[],
  Queries extends readonly AnyQueryContract[],
> {
  /** Service name, kebab-case. Becomes the OpenAPI title. */
  readonly name: string;
  readonly description?: string;
  /**
   * Who may run operations that do not set their own `access`. Required, so that opening a
   * service to anonymous callers is always a visible decision.
   */
  readonly access: Access;
  readonly commands?: Commands;
  readonly queries?: Queries;
}

/**
 * Collect a service's commands and queries. This is the service's driving port: the HTTP and
 * messaging adapters, the OpenAPI document and typed clients are all derived from it.
 */
export function defineContracts<
  const Commands extends readonly AnyCommandContract[] = readonly [],
  const Queries extends readonly AnyQueryContract[] = readonly [],
>(options: DefineContractsOptions<Commands, Queries>): Contracts<Commands, Queries> {
  if (!KEBAB_CASE.test(options.name)) {
    panic(`defineContracts: name "${options.name}" must be kebab-case`);
  }
  const commands = (options.commands ?? []) as unknown as Commands;
  const queries = (options.queries ?? []) as unknown as Queries;
  const index = new Map<string, AnyOperationContract>();
  for (const contract of [...commands, ...queries] as AnyOperationContract[]) {
    const id = `${contract.kind}:${contract.key}`;
    if (index.has(id)) panic(`defineContracts("${options.name}"): ${contract.kind} ${contract.key} is listed twice`);
    index.set(id, contract);
  }
  const access = checkAccess(`defineContracts("${options.name}")`, options.access);
  return {
    name: options.name,
    description: options.description,
    commands,
    queries,
    access,
    find: (kind, type, version) => index.get(`${kind}:${type}@${version}`),
    accessOf: (contract) => contract.access ?? access,
  };
}
