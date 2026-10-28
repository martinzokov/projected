import { operationsOf, resolvePointer, type OpenApiDocument, type Operation, type Schema } from "./spec.js";

/** One difference between the pinned spec and a new one. */
export interface SpecChange {
  /** Would code generated from the old spec break against the new API? */
  readonly breaking: boolean;
  /** `GET /v1/forecast` */
  readonly operation: string;
  readonly description: string;
}

type Direction = "request" | "response";

const typesOf = (schema: Schema) => (schema.type === undefined ? [] : Array.isArray(schema.type) ? [...schema.type] : [schema.type as string]);

/**
 * Compare the schema we send (request) or receive (response) under the old and the new spec.
 * Requests break when the API starts demanding something we do not send; responses break when
 * the API stops sending something our schema requires, or sends something it rejects.
 */
function compareSchemas(
  oldDoc: OpenApiDocument,
  newDoc: OpenApiDocument,
  before: Schema,
  after: Schema,
  direction: Direction,
  where: string,
  seen: Set<string>,
): string[] {
  const resolve = (document: OpenApiDocument, schema: Schema): Schema => {
    let current = schema;
    for (let hops = 0; current.$ref !== undefined && hops < 20; hops++) current = (resolvePointer(document, current.$ref) as Schema) ?? {};
    return current;
  };
  const visitKey = `${direction}:${where}:${before.$ref ?? ""}:${after.$ref ?? ""}`;
  if (seen.has(visitKey)) return [];
  seen.add(visitKey);
  const a = resolve(oldDoc, before);
  const b = resolve(newDoc, after);
  const problems: string[] = [];

  const ta = typesOf(a).filter((t) => t !== "null");
  const tb = typesOf(b).filter((t) => t !== "null");
  const nullableA = a.nullable === true || typesOf(a).includes("null");
  const nullableB = b.nullable === true || typesOf(b).includes("null");
  if (ta.length > 0 && tb.length > 0 && ta.join() !== tb.join()) {
    const widenedToNumber = direction === "request" && ta.join() === "integer" && tb.join() === "number";
    const narrowedToInteger = direction === "response" && ta.join() === "number" && tb.join() === "integer";
    if (!widenedToNumber && !narrowedToInteger) problems.push(`${where}: type ${ta.join("|")} became ${tb.join("|")}`);
    return problems;
  }
  if (direction === "response" && nullableB && !nullableA) problems.push(`${where}: may now be null`);
  if (direction === "request" && nullableA && !nullableB) problems.push(`${where}: no longer accepts null`);

  if (a.enum !== undefined && b.enum !== undefined) {
    const added = b.enum.filter((value) => !a.enum?.includes(value));
    const removed = a.enum.filter((value) => !b.enum?.includes(value));
    if (direction === "response" && added.length > 0) problems.push(`${where}: new values ${JSON.stringify(added)} would be rejected`);
    if (direction === "request" && removed.length > 0) problems.push(`${where}: no longer accepts ${JSON.stringify(removed)}`);
  }

  const propsA = a.properties ?? {};
  const propsB = b.properties ?? {};
  const requiredA = new Set(a.required ?? []);
  const requiredB = new Set(b.required ?? []);
  for (const [key, property] of Object.entries(propsA)) {
    const next = propsB[key];
    if (direction === "response" && requiredA.has(key) && (next === undefined || !requiredB.has(key))) {
      problems.push(`${where}.${key}: ${next === undefined ? "removed" : "no longer always present"}`);
      continue;
    }
    if (next !== undefined) problems.push(...compareSchemas(oldDoc, newDoc, property, next, direction, `${where}.${key}`, seen));
  }
  if (direction === "request") {
    for (const key of requiredB) {
      if (!requiredA.has(key)) problems.push(`${where}.${key}: now required`);
    }
  }
  if (a.items !== undefined && b.items !== undefined) {
    problems.push(...compareSchemas(oldDoc, newDoc, a.items, b.items, direction, `${where}[]`, seen));
  }
  return problems;
}

/** Every difference between two versions of a vendor's spec, breaking ones first. */
export function compareSpecs(oldDoc: OpenApiDocument, newDoc: OpenApiDocument): SpecChange[] {
  const before = new Map(operationsOf(oldDoc).map((op) => [op.key, op]));
  const after = new Map(operationsOf(newDoc).map((op) => [op.key, op]));
  const changes: SpecChange[] = [];
  const add = (breaking: boolean, operation: string, description: string) => changes.push({ breaking, operation, description });

  for (const [key, old] of before) {
    const next = after.get(key);
    if (next === undefined) {
      add(true, key, "removed");
      continue;
    }
    compareOperation(oldDoc, newDoc, old, next, add);
  }
  for (const key of after.keys()) if (!before.has(key)) add(false, key, "added");
  return changes.sort((x, y) => Number(y.breaking) - Number(x.breaking) || x.operation.localeCompare(y.operation));
}

function compareOperation(
  oldDoc: OpenApiDocument,
  newDoc: OpenApiDocument,
  old: Operation,
  next: Operation,
  add: (breaking: boolean, operation: string, description: string) => void,
) {
  const key = old.key;
  const seen = new Set<string>();
  const oldParams = new Map(old.parameters.map((p) => [`${p.in}:${p.name}`, p]));
  for (const parameter of next.parameters) {
    const previous = oldParams.get(`${parameter.in}:${parameter.name}`);
    if (previous === undefined) {
      add(parameter.required, key, `new ${parameter.required ? "required" : "optional"} ${parameter.in} parameter "${parameter.name}"`);
      continue;
    }
    if (parameter.required && !previous.required) add(true, key, `${parameter.in} parameter "${parameter.name}" is now required`);
    for (const problem of compareSchemas(oldDoc, newDoc, previous.schema, parameter.schema, "request", parameter.name, seen)) {
      add(true, key, `${parameter.in} parameter ${problem}`);
    }
  }
  for (const [id, parameter] of oldParams) {
    if (!next.parameters.some((p) => `${p.in}:${p.name}` === id)) add(false, key, `${parameter.in} parameter "${parameter.name}" removed`);
  }
  if (next.body !== undefined && old.body === undefined && next.body.required) add(true, key, "now requires a request body");
  if (next.body !== undefined && old.body !== undefined) {
    if (next.body.required && !old.body.required) add(true, key, "request body is now required");
    for (const problem of compareSchemas(oldDoc, newDoc, old.body.schema, next.body.schema, "request", "body", seen)) {
      add(true, key, `request ${problem}`);
    }
  }
  if (old.response !== undefined && next.response === undefined) add(true, key, "no longer returns a JSON body");
  if (old.response !== undefined && next.response !== undefined) {
    for (const problem of compareSchemas(oldDoc, newDoc, old.response, next.response, "response", "response", seen)) {
      add(true, key, problem);
    }
  }
}
