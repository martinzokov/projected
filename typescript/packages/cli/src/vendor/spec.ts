import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * The part of OpenAPI 3.0/3.1 that `projected vendor` understands: JSON request and response
 * bodies, path, query and header parameters, and schemas built from objects, arrays,
 * primitives, enums, `oneOf`/`anyOf`/`allOf` and local `$ref`s. Everything else degrades to
 * `z.unknown()` rather than failing, so a partly exotic API is still usable.
 */
export interface Schema {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly nullable?: boolean;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Schema;
  readonly items?: Schema;
  readonly oneOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly allOf?: readonly Schema[];
}

interface Parameter {
  readonly $ref?: string;
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required?: boolean;
  readonly schema?: Schema;
}

interface MediaTypes {
  readonly content?: Readonly<Record<string, { readonly schema?: Schema }>>;
}

interface RawOperation {
  readonly operationId?: string;
  readonly parameters?: readonly Parameter[];
  readonly requestBody?: MediaTypes & { readonly $ref?: string; readonly required?: boolean };
  readonly responses?: Readonly<Record<string, MediaTypes & { readonly $ref?: string }>>;
}

export interface OpenApiDocument {
  readonly openapi?: string;
  readonly servers?: readonly { readonly url: string }[];
  readonly paths?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly components?: { readonly schemas?: Readonly<Record<string, Schema>> } & Readonly<Record<string, unknown>>;
}

export const METHODS = ["get", "put", "post", "delete", "patch"] as const;

export interface OperationParameter {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly required: boolean;
  readonly schema: Schema;
}

/** One operation, with every local `$ref` outside schemas resolved. */
export interface Operation {
  /** `GET /v1/forecast` — stable even when the vendor renames the operationId. */
  readonly key: string;
  readonly method: (typeof METHODS)[number];
  readonly path: string;
  readonly operationId: string | undefined;
  readonly parameters: readonly OperationParameter[];
  readonly body: { readonly required: boolean; readonly schema: Schema } | undefined;
  /** The schema of the success body; undefined when the operation returns no JSON. */
  readonly response: Schema | undefined;
}

/** Read a spec from a file path or an http(s) URL, as JSON or YAML. */
export async function readSpecSource(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Could not download ${source}: HTTP ${response.status}`);
    return response.text();
  }
  return readFileSync(source, "utf8");
}

export function parseSpec(text: string, source: string): OpenApiDocument {
  const trimmed = text.trimStart();
  const parsed: unknown = trimmed.startsWith("{") ? JSON.parse(text) : parseYaml(text);
  const document = parsed as OpenApiDocument | null;
  if (document === null || typeof document !== "object" || typeof document.openapi !== "string" || !document.openapi.startsWith("3.")) {
    throw new Error(`${source} is not an OpenAPI 3 document (no "openapi": "3.x" field). Swagger 2 specs must be converted first.`);
  }
  return document;
}

/**
 * The pinned form of a spec: plain JSON in the vendor's own key order, so generated code lists
 * fields as the vendor documents them, and a client generated from the pin is byte-identical to
 * one generated from the original YAML or JSON.
 */
export function canonicalSpec(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export const specHash = (pinned: string) => `sha256-${createHash("sha256").update(pinned).digest("base64")}`;

/** Follow a local `#/...` reference. Remote references are not supported. */
export function resolvePointer(document: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`Only local $refs are supported, found "${ref}".`);
  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], document);
}

function deref<T extends { readonly $ref?: string }>(document: OpenApiDocument, value: T): T {
  let current: T = value;
  for (let hops = 0; current.$ref !== undefined; hops++) {
    if (hops > 20) throw new Error(`$ref cycle at ${current.$ref}`);
    current = resolvePointer(document, current.$ref) as T;
    if (current === undefined) throw new Error(`Unresolvable $ref "${value.$ref}".`);
  }
  return current;
}

const isJson = (contentType: string) => contentType === "application/json" || contentType.endsWith("+json") || contentType === "*/*";

function jsonSchema(media: MediaTypes | undefined): Schema | undefined {
  const content = media?.content ?? {};
  const type = Object.keys(content).find(isJson);
  return type === undefined ? undefined : (content[type]?.schema ?? {});
}

const SUCCESS = ["200", "201", "202", "203", "2XX", "2xx", "default"];

export function operationsOf(document: OpenApiDocument): Operation[] {
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    const shared = ((item as { parameters?: readonly Parameter[] }).parameters ?? []).map((p) => deref(document, p));
    for (const method of METHODS) {
      const raw = item[method] as RawOperation | undefined;
      if (raw === undefined) continue;
      const own = (raw.parameters ?? []).map((p) => deref(document, p));
      const byKey = new Map<string, Parameter>();
      for (const parameter of [...shared, ...own]) byKey.set(`${parameter.in}:${parameter.name}`, parameter);
      const parameters = [...byKey.values()]
        .filter((p): p is Parameter & { in: "path" | "query" | "header" } => p.in !== "cookie")
        .map((p) => ({ name: p.name, in: p.in, required: p.in === "path" || p.required === true, schema: p.schema ?? {} }));
      const requestBody = raw.requestBody === undefined ? undefined : deref(document, raw.requestBody);
      const bodySchema = jsonSchema(requestBody);
      const responses = raw.responses ?? {};
      const success = SUCCESS.find((status) => responses[status] !== undefined);
      const response = success === undefined ? undefined : jsonSchema(deref(document, responses[success] ?? {}));
      operations.push({
        key: `${method.toUpperCase()} ${path}`,
        method,
        path,
        operationId: raw.operationId,
        parameters,
        body: bodySchema === undefined ? undefined : { required: requestBody?.required === true, schema: bodySchema },
        response,
      });
    }
  }
  return operations.sort((a, b) => a.key.localeCompare(b.key));
}
