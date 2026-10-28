import type { Schema } from "./spec.js";

/** PascalCase identifier from any name: `pet-store.Item` → `PetStoreItem`. */
export function pascal(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
  const joined = words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join("");
  return /^[A-Za-z]/.test(joined) ? joined : `T${joined}`;
}

export const camel = (name: string) => {
  const p = pascal(name);
  return p[0]?.toLowerCase() + p.slice(1);
};

export interface ZodContext {
  /** `#/components/schemas/Pet` → `Pet`. */
  readonly names: ReadonlyMap<string, string>;
  /** Schemas already emitted above the one being written; references to others are lazy. */
  readonly defined: ReadonlySet<string>;
}

const literal = (value: unknown) => JSON.stringify(value);
const typesOf = (schema: Schema) => (schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type as string]);

/** A zod 4 expression for `schema`. Unknown constructs become `z.unknown()`. */
export function zodOf(schema: Schema, context: ZodContext): string {
  const nullable = schema.nullable === true || typesOf(schema).includes("null");
  const expression = baseOf(schema, context);
  return nullable && expression !== "z.null()" ? `${expression}.nullable()` : expression;
}

function baseOf(schema: Schema, context: ZodContext): string {
  if (schema.$ref !== undefined) {
    const name = context.names.get(schema.$ref);
    if (name === undefined) return "z.unknown()";
    // A forward or recursive reference: resolved when first used.
    return context.defined.has(name) ? name : `z.lazy((): z.ZodType => ${name})`;
  }
  if (schema.const !== undefined) return `z.literal(${literal(schema.const)})`;
  if (schema.enum !== undefined && schema.enum.length > 0) {
    const values = schema.enum.filter((value) => value !== null);
    if (values.length === 0) return "z.null()";
    if (values.every((value) => typeof value === "string")) return `z.enum([${values.map(literal).join(", ")}])`;
    return values.length === 1 ? `z.literal(${literal(values[0])})` : `z.union([${values.map((v) => `z.literal(${literal(v)})`).join(", ")}])`;
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives !== undefined && alternatives.length > 0) {
    const parts = alternatives.map((alternative) => zodOf(alternative, context));
    return parts.length === 1 ? (parts[0] as string) : `z.union([${parts.join(", ")}])`;
  }
  if (schema.allOf !== undefined && schema.allOf.length > 0) {
    const parts = schema.allOf.map((part) => zodOf(part, context));
    return parts.slice(1).reduce((all, part) => `z.intersection(${all}, ${part})`, parts[0] as string);
  }
  const types = typesOf(schema).filter((type) => type !== "null");
  if (types.length > 1) return `z.union([${types.map((type) => baseOf({ ...schema, type }, context)).join(", ")}])`;
  const type = types[0] ?? (schema.properties !== undefined ? "object" : schema.items !== undefined ? "array" : undefined);
  switch (type) {
    case "string":
      return "z.string()";
    case "integer":
      return "z.number().int()";
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "null":
      return "z.null()";
    case "array":
      return `z.array(${schema.items === undefined ? "z.unknown()" : zodOf(schema.items, context)})`;
    case "object":
      return objectOf(schema, context);
    default:
      return "z.unknown()";
  }
}

function objectOf(schema: Schema, context: ZodContext): string {
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(schema.properties ?? {});
  const extra = schema.additionalProperties;
  const rest = extra === undefined || extra === false ? undefined : extra === true ? "z.unknown()" : zodOf(extra, context);
  if (entries.length === 0) return rest === undefined ? "z.object({})" : `z.record(z.string(), ${rest})`;
  const shape = entries
    .map(([key, property]) => `${literal(key)}: ${zodOf(property, context)}${required.has(key) ? "" : ".optional()"}`)
    .join(", ");
  // Unknown keys are stripped, not rejected: a vendor adding a field must not break us.
  return rest === undefined ? `z.object({ ${shape} })` : `z.object({ ${shape} }).catchall(${rest})`;
}

/** The components a schema references directly, for ordering definitions. */
export function referencesOf(schema: Schema): string[] {
  const found: string[] = [];
  const visit = (node: Schema | undefined) => {
    if (node === undefined) return;
    if (node.$ref !== undefined) found.push(node.$ref);
    Object.values(node.properties ?? {}).forEach(visit);
    if (typeof node.additionalProperties === "object") visit(node.additionalProperties);
    visit(node.items);
    [...(node.oneOf ?? []), ...(node.anyOf ?? []), ...(node.allOf ?? [])].forEach(visit);
  };
  visit(schema);
  return found;
}
