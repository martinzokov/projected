import { operationsOf, type OpenApiDocument, type Operation, type OperationParameter, type Schema } from "./spec.js";
import { camel, pascal, referencesOf, zodOf, type ZodContext } from "./zod.js";

/** Where a vendor's files live, relative to the project root. */
export const vendorPaths = (name: string) => ({
  spec: `vendor/${name}.openapi.json`,
  client: `src/infrastructure/adapter/driven/${name}/${name}-client.ts`,
  adapter: `src/infrastructure/adapter/driven/${name}/${name}-adapter.ts`,
  port: `src/application/port/driven/${name}.ts`,
});

const COMPONENT_PREFIX = "#/components/schemas/";

/** Components in an order where each is defined before it is used; cycles fall back to `z.lazy`. */
function orderComponents(schemas: Readonly<Record<string, Schema>>): string[] {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string) => {
    if (state.has(name) || schemas[name] === undefined) return;
    state.set(name, "visiting");
    for (const ref of referencesOf(schemas[name] as Schema)) {
      if (ref.startsWith(COMPONENT_PREFIX)) visit(ref.slice(COMPONENT_PREFIX.length));
    }
    state.set(name, "done");
    order.push(name);
  };
  Object.keys(schemas).sort().forEach(visit);
  return order;
}

interface InputField {
  readonly key: string;
  readonly parameter: OperationParameter | undefined;
  readonly schema: Schema;
  readonly required: boolean;
}

function inputFields(operation: Operation): InputField[] {
  const counts = new Map<string, number>();
  for (const p of operation.parameters) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  const fields: InputField[] = operation.parameters.map((p) => ({
    // Headers are case-insensitive and rarely identifiers (`X-Api-Key`): callers pass `xApiKey`.
    key:
      (counts.get(p.name) ?? 0) > 1 || p.name === "body" ? `${p.in}${pascal(p.name)}` : p.in === "header" ? camel(p.name) : p.name,
    parameter: p,
    schema: p.schema,
    required: p.required,
  }));
  if (operation.body !== undefined) {
    fields.push({ key: "body", parameter: undefined, schema: operation.body.schema, required: operation.body.required });
  }
  return fields;
}

const read = (key: string) => `input[${JSON.stringify(key)}]`;
const typesOf = (schema: Schema) => (schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]);

/** How a parameter value goes into a query string: comma-joined arrays, JSON for objects. */
function queryValue(field: InputField): string {
  const value = read(field.key);
  const types = typesOf(field.schema);
  if (types.includes("array")) return field.required && !types.includes("null") ? `${value}.join(",")` : `${value}?.join(",")`;
  if (types.includes("object") || (types.length === 0 && field.schema.enum === undefined && field.schema.$ref !== undefined)) {
    return `${value} === undefined ? undefined : JSON.stringify(${value})`;
  }
  if (types.length === 0 && field.schema.enum === undefined) return `${value} === undefined ? undefined : String(${value})`;
  return types.includes("null") || field.schema.nullable === true ? `${value} ?? undefined` : value;
}

function pathTemplate(operation: Operation, fields: readonly InputField[]): string {
  const keyOf = new Map(fields.filter((f) => f.parameter?.in === "path").map((f) => [f.parameter?.name, f.key]));
  const path = operation.path.replace(/[`\\$]/g, (char) => `\\${char}`);
  return "`" + path.replace(/\{([^}]+)\}/g, (_all, name: string) => `\${encodeURIComponent(String(${read(keyOf.get(name) ?? name)}))}`) + "`";
}

function methodName(operation: Operation, used: Set<string>): string {
  const base =
    operation.operationId !== undefined && operation.operationId !== ""
      ? camel(operation.operationId)
      : camel(`${operation.method} ${operation.path.replace(/\{([^}]+)\}/g, "by $1")}`);
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}${n}`;
  used.add(name);
  return name;
}

export interface GenerateOptions {
  /** The vendor's name, kebab-case: `weather`. */
  readonly name: string;
  readonly document: OpenApiDocument;
  /** Path of the pinned spec, for the header. */
  readonly specPath: string;
  readonly specHash: string;
}

/**
 * The client module for one vendor: zod schemas for its components and operations, and a
 * client whose every method calls projected's `httpClient` and returns its Result.
 */
export function generateClient(options: GenerateOptions): string {
  const { name, document } = options;
  const schemas = document.components?.schemas ?? {};
  const used = new Set<string>(["CallOptions"]);
  const identifier = (wanted: string) => {
    let id = wanted;
    for (let n = 2; used.has(id); n++) id = `${wanted}${n}`;
    used.add(id);
    return id;
  };
  const names = new Map<string, string>();
  for (const component of Object.keys(schemas).sort()) names.set(`${COMPONENT_PREFIX}${component}`, identifier(pascal(component)));

  const defined = new Set<string>();
  const context: ZodContext = { names, defined };
  const lines: string[] = [
    `// Generated by \`projected vendor\` from ${options.specPath} (${options.specHash}).`,
    `// Do not edit: change the spec with \`projected vendor update ${name}\`, or regenerate with \`projected vendor generate\`.`,
    `import { z } from "@projected/application";`,
    `import type { ExpectedStatuses, HttpClient } from "@projected/http";`,
    "",
  ];
  const server = document.servers?.[0]?.url;
  if (server !== undefined) {
    lines.push(`/** The first server the spec lists. */`, `export const ${name.replace(/-/g, "_").toUpperCase()}_BASE_URL = ${JSON.stringify(server)};`, "");
  }

  for (const component of orderComponents(schemas)) {
    const id = names.get(`${COMPONENT_PREFIX}${component}`) as string;
    lines.push(`export const ${id} = ${zodOf(schemas[component] as Schema, context)};`, `export type ${id} = z.output<typeof ${id}>;`, "");
    defined.add(id);
  }

  const methods: string[] = [];
  const methodNames = new Set<string>();
  for (const operation of operationsOf(document)) {
    const method = methodName(operation, methodNames);
    const type = pascal(method);
    const fields = inputFields(operation);
    const input = identifier(`${type}Input`);
    const response = identifier(`${type}Response`);
    const shape = fields.map((f) => `${JSON.stringify(f.key)}: ${zodOf(f.schema, context)}${f.required ? "" : ".optional()"}`).join(", ");
    lines.push(
      `export const ${input} = z.object({ ${shape} });`,
      `export type ${input} = z.input<typeof ${input}>;`,
      `export const ${response} = ${operation.response === undefined ? "z.unknown()" : zodOf(operation.response, context)};`,
      `export type ${response} = z.output<typeof ${response}>;`,
      "",
    );

    const query = fields.filter((f) => f.parameter?.in === "query");
    const headers = fields.filter((f) => f.parameter?.in === "header");
    const request = [
      `method: ${JSON.stringify(operation.method.toUpperCase())}`,
      `path: ${pathTemplate(operation, fields)}`,
      ...(query.length === 0 ? [] : [`query: { ${query.map((f) => `${JSON.stringify(f.parameter?.name)}: ${queryValue(f)}`).join(", ")} }`]),
      ...(headers.length === 0
        ? []
        : [
            `headers: { ${headers
              .map((f) =>
                f.required
                  ? `${JSON.stringify(f.parameter?.name)}: String(${read(f.key)})`
                  : `...(${read(f.key)} === undefined ? {} : { ${JSON.stringify(f.parameter?.name)}: String(${read(f.key)}) })`,
              )
              .join(", ")} }`,
          ]),
      ...(operation.body === undefined ? [] : [`body: ${read("body")}`]),
      `response: ${response}`,
      `expectedErrors: options.expectedErrors`,
    ];
    const optional = fields.every((f) => !f.required);
    methods.push(
      `  /** ${operation.key} */`,
      `  ${method}: <const X extends ExpectedStatuses = undefined>(${fields.length === 0 ? "_input" : "input"}: ${input}${optional ? " = {}" : ""}, options: CallOptions<X> = {}) =>`,
      "    http.request({",
      ...request.map((property) => `      ${property},`),
      "    }),",
    );
  }

  const factory = `${camel(name)}Client`;
  lines.push(
    "export interface CallOptions<X extends ExpectedStatuses = undefined> {",
    "  /** Statuses to return as HttpStatusError instead of a failure, to model them in the adapter, e.g. `[404]`. */",
    "  readonly expectedErrors?: X;",
    "}",
    "",
    `/** ${name}'s API on projected's \`httpClient\`: every call returns a Result, never throws. */`,
    `export const ${factory} = (http: HttpClient) => ({`,
    ...methods,
    "});",
    `export type ${pascal(name)}Client = ReturnType<typeof ${factory}>;`,
    "",
  );
  return lines.join("\n");
}

/** The port and adapter a new vendor starts with. Written once; they are yours from then on. */
export function starterFiles(name: string): { readonly port: string; readonly adapter: string } {
  const port = pascal(name);
  return {
    port: [
      "/**",
      ` * What the application needs from ${name}, in the application's own words — not the vendor's.`,
      " * Add operations as use cases need them, each returning",
      " * `Promise<Result<YourType, DependencyUnavailable | DependencyFailure>>` (from @projected/application).",
      " */",
      `export interface ${port} {}`,
      "",
    ].join("\n"),
    adapter: [
      `import type { ${port} } from "../../../../application/port/driven/${name}.js";`,
      `import type { ${port}Client } from "./${name}-client.js";`,
      "",
      "/**",
      ` * The ${port} port on ${name}'s API. Vendor names and shapes stay in this directory: map each`,
      " * response into the port's types, and statuses that mean something (`expectedErrors`) into",
      " * business outcomes.",
      " */",
      `export const ${camel(name)}Adapter = (_client: ${port}Client): ${port} => ({});`,
      "",
    ].join("\n"),
  };
}
