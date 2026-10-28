import { z } from "@projected/application";
import fc from "fast-check";

/** fast-check itself, for arbitraries the helpers below do not cover. */
export { fc };

type JsonSchema = {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly format?: string;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly items?: JsonSchema;
  readonly prefixItems?: readonly JsonSchema[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
};

const MAX_DEPTH = 4;
const DAY = 86_400_000;
const isoInstant = (min = Date.UTC(1970, 0, 1), max = Date.UTC(2100, 0, 1)) => fc.integer({ min: min / DAY, max: max / DAY }).chain((day) => fc.integer({ min: 0, max: DAY - 1 }).map((ms) => new Date(day * DAY + ms)));

function stringOf(schema: JsonSchema): fc.Arbitrary<string> {
  switch (schema.format) {
    case "date":
      return isoInstant().map((date) => date.toISOString().slice(0, 10));
    case "date-time":
      return isoInstant().map((date) => date.toISOString());
    case "email":
      return fc.emailAddress();
    case "uuid":
      return fc.uuid();
    case "uri":
    case "url":
      return fc.webUrl();
    default:
      if (schema.pattern !== undefined) return fc.stringMatching(new RegExp(schema.pattern));
      return fc.string({ minLength: schema.minLength ?? 0, maxLength: schema.maxLength ?? Math.max(schema.minLength ?? 0, 20) });
  }
}

function numberOf(schema: JsonSchema, integer: boolean): fc.Arbitrary<number> {
  const min = schema.minimum ?? (schema.exclusiveMinimum === undefined ? undefined : schema.exclusiveMinimum + (integer ? 1 : Number.EPSILON));
  const max = schema.maximum ?? (schema.exclusiveMaximum === undefined ? undefined : schema.exclusiveMaximum - (integer ? 1 : Number.EPSILON));
  if (integer) return fc.integer({ min: Math.ceil(min ?? -1_000_000), max: Math.floor(max ?? 1_000_000) });
  return fc.double({ min: min ?? -1_000_000, max: max ?? 1_000_000, noNaN: true, noDefaultInfinity: true });
}

function arbitraryOf(schema: JsonSchema, root: JsonSchema, depth: number): fc.Arbitrary<unknown> {
  if (schema.$ref !== undefined) {
    const name = schema.$ref.replace(/^#\/\$defs\//, "");
    const target = root.$defs?.[name];
    return target === undefined || depth > MAX_DEPTH ? fc.constant(undefined) : arbitraryOf(target, root, depth + 1);
  }
  if (schema.const !== undefined) return fc.constant(schema.const);
  if (schema.enum !== undefined) return fc.constantFrom(...schema.enum);
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives !== undefined) return fc.oneof(...alternatives.map((alternative) => arbitraryOf(alternative, root, depth + 1)));
  if (schema.allOf !== undefined && schema.allOf.length > 0) {
    // Objects only: generate each part and merge them.
    return fc.tuple(...schema.allOf.map((part) => arbitraryOf(part, root, depth + 1))).map((parts) => Object.assign({}, ...parts));
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type as string];
  if (types.length > 1) return fc.oneof(...types.map((type) => arbitraryOf({ ...schema, type }, root, depth)));
  switch (types[0]) {
    case "string":
      return stringOf(schema);
    case "integer":
      return numberOf(schema, true);
    case "number":
      return numberOf(schema, false);
    case "boolean":
      return fc.boolean();
    case "null":
      return fc.constant(null);
    case "array": {
      if (schema.prefixItems !== undefined) return fc.tuple(...schema.prefixItems.map((item) => arbitraryOf(item, root, depth + 1)));
      const maxLength = depth > MAX_DEPTH ? 0 : (schema.maxItems ?? Math.max(schema.minItems ?? 0, 4));
      return fc.array(arbitraryOf(schema.items ?? {}, root, depth + 1), { minLength: schema.minItems ?? 0, maxLength });
    }
    case "object": {
      const properties = Object.entries(schema.properties ?? {});
      const shape = Object.fromEntries(properties.map(([key, property]) => [key, arbitraryOf(property, root, depth + 1)]));
      const record = fc.record(shape, { requiredKeys: [...(schema.required ?? [])] as never[] });
      const extra = schema.additionalProperties;
      if (properties.length === 0 && typeof extra === "object") return fc.dictionary(fc.string({ maxLength: 10 }), arbitraryOf(extra, root, depth + 1), { maxKeys: 4 });
      return record;
    }
    default:
      return fc.jsonValue();
  }
}

/**
 * Values valid for a zod schema. Candidates follow the schema's JSON Schema (formats, lengths,
 * ranges, enums, nesting) and are then parsed by the schema itself, so refinements and
 * transforms hold too: what you get is exactly what the schema accepts and outputs.
 *
 * ```ts
 * forAll([fromSchema(WithdrawStudent.input)], (input) => { ... });
 * ```
 */
export function fromSchema<S extends z.ZodType>(schema: S): fc.Arbitrary<z.output<S>> {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as JsonSchema;
  return arbitraryOf(json, json, 0)
    .map((candidate) => schema.safeParse(candidate))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data as z.output<S>);
}

export interface ForAllOptions {
  /** How many cases to try. Defaults to 200. */
  readonly runs?: number;
  /** Replay a failure: the seed fast-check printed. */
  readonly seed?: number;
}

/**
 * Check that `property` holds for every generated case — it fails by throwing, so the usual
 * `expect` and `given(...).then...` assertions work inside. A failing case is shrunk to the
 * smallest one fast-check can find, and reported with the seed that replays it.
 */
export function forAll<const Ts extends readonly unknown[]>(
  arbitraries: { readonly [K in keyof Ts]: fc.Arbitrary<Ts[K]> },
  property: (...values: Ts) => void,
  options: ForAllOptions = {},
): void {
  // fc.property is overloaded per arity; spreading a tuple of arbitraries needs one loose signature.
  const propertyOf = fc.property as unknown as (...args: unknown[]) => fc.IPropertyWithHooks<unknown[]>;
  fc.assert(
    propertyOf(...(arbitraries as readonly unknown[]), (...values: unknown[]) => {
      property(...(values as unknown as Ts));
    }),
    { numRuns: options.runs ?? 200, includeErrorInReport: true, ...(options.seed === undefined ? {} : { seed: options.seed }) },
  );
}
