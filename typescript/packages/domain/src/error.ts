import { TaggedError, panic, type TaggedErrorInstance } from "better-result";
import { z } from "zod";

/** Property names a business error's schema may not declare: `Error` and `TaggedError` own them. */
const RESERVED_ERROR_PROPERTIES = ["_tag", "name", "message", "stack", "cause", "match", "toJSON"];

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;

/** Tags of the framework's own errors. A business error reusing one would be misrouted by transports. */
const RESERVED_TAGS = [
  "Panic",
  "UnhandledException",
  "EventDecodingFailed",
  "UnknownOperation",
  "InvalidInput",
  "OperationDefect",
  "ConcurrencyConflict",
  "DependencyUnavailable",
  "DependencyFailure",
  "Unauthenticated",
  "Forbidden",
  "RequestInProgress",
  "IdempotencyKeyReused",
];

/** The instance type of an error created by {@link defineError}. */
export type BusinessError<Tag extends string = string, Props = Record<string, unknown>> = TaggedErrorInstance<
  Tag,
  Props & { readonly message: string }
>;

/** The constructor (class) produced by {@link defineError}. Extend it: `class X extends defineError(...) {}`. */
export interface BusinessErrorClass<Tag extends string = string, S extends z.ZodObject = z.ZodObject> {
  new (
    ...args: [{}] extends [z.output<S>] ? [props?: z.output<S>] : [props: z.output<S>]
  ): BusinessError<Tag, z.output<S>>;
  /** The error's tag: its name in code, in `match` handlers and on the wire. */
  readonly tag: Tag;
  /** Schema of the error's data. Used for OpenAPI and to rebuild the error on the client side. */
  readonly schema: S;
  readonly description: string | undefined;
  /** Type guard for this error class. */
  is<C extends abstract new (...args: never[]) => object>(this: C, value: unknown): value is InstanceType<C>;
}

/** Any class produced by {@link defineError}. */
// `any` is deliberate: constructor parameters are contravariant, so a concrete error class is not
// assignable to `BusinessErrorClass<string, z.ZodObject>`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBusinessErrorClass = BusinessErrorClass<string, any>;

export interface DefineErrorOptions<S extends z.ZodObject> {
  /** Data carried by the error. Must be JSON-compatible: it is sent to clients. Defaults to no data. */
  readonly schema?: S;
  /** Human-readable message, static or derived from the error's data. Defaults to the tag. */
  readonly message?: string | ((props: z.output<S>) => string);
  /** Explanation for API consumers, rendered into OpenAPI. */
  readonly description?: string;
}

/**
 * Define an expected business failure — something a caller can make a decision about.
 *
 * ```ts
 * export class StudentAlreadyEnlisted extends defineError("StudentAlreadyEnlisted", {
 *   schema: z.object({ studentId: z.string() }),
 *   message: ({ studentId }) => `Student ${studentId} is already enlisted`,
 * }) {}
 *
 * return Result.err(new StudentAlreadyEnlisted({ studentId }));
 * ```
 *
 * The result is a real `Error` subclass built on better-result's `TaggedError`, so it works with
 * `Result.gen`, `.match()` and `matchError`. Unlike a bare `TaggedError`, it carries a runtime
 * schema, which lets projected document it in OpenAPI and reconstruct it in typed clients.
 */
export function defineError<const Tag extends string, S extends z.ZodObject = z.ZodObject<{}>>(
  tag: Tag,
  options: DefineErrorOptions<S> = {},
): BusinessErrorClass<Tag, S> {
  if (!PASCAL_CASE.test(tag)) {
    panic(`defineError: tag "${tag}" must be PascalCase, e.g. "StudentAlreadyEnlisted"`);
  }
  if (RESERVED_TAGS.includes(tag)) {
    panic(`defineError: tag "${tag}" is reserved for projected's own errors`);
  }
  const schema = (options.schema ?? z.object({})) as S;
  const reserved = Object.keys(schema.shape).filter((key) => RESERVED_ERROR_PROPERTIES.includes(key));
  if (reserved.length > 0) {
    panic(`defineError("${tag}"): schema declares reserved properties: ${reserved.join(", ")}`);
  }
  const message = options.message ?? tag;
  const toMessage = (props: z.output<S>): string => (typeof message === "function" ? message(props) : message);

  // `TaggedError(tag)` has a generic construct signature that TypeScript cannot relate to a
  // generic `S`, so the base is typed loosely here and the public type is restored on return.
  const Base = TaggedError(tag) as unknown as new (props: Record<string, unknown>) => Error;

  class DefinedBusinessError extends Base {
    static readonly tag = tag;
    static readonly schema = schema;
    static readonly description = options.description;
    constructor(props?: z.output<S>) {
      const data = (props ?? {}) as z.output<S>;
      super({ ...data, message: toMessage(data) });
    }
  }
  Object.defineProperty(DefinedBusinessError, "name", { value: tag });
  return DefinedBusinessError as unknown as BusinessErrorClass<Tag, S>;
}

/** True when `value` was created by a class produced by {@link defineError}. */
export function isBusinessErrorClass(value: unknown): value is AnyBusinessErrorClass {
  return (
    typeof value === "function" &&
    "tag" in value &&
    typeof value.tag === "string" &&
    "schema" in value &&
    value.schema instanceof z.ZodObject
  );
}
