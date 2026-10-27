import type { AnyBusinessErrorClass, AnyContracts, AnyOperationContract } from "@projected/application";
import { panic } from "better-result";
import { z } from "zod";
import { HEADERS, PLURAL, operationId, operationPath } from "./protocol.js";

type JsonSchema = Record<string, unknown>;

export interface OpenApiOptions {
  /** `info.version` — the version of the service, not of any operation. Defaults to `0.0.0`. */
  readonly version?: string;
  /** `info.title`. Defaults to the contracts' name. */
  readonly title?: string;
  readonly servers?: ReadonlyArray<{ readonly url: string; readonly description?: string }>;
  /** Prefix for every path, matching the handler's `basePath`. */
  readonly basePath?: string;
}

/** An OpenAPI 3.1 document. */
export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string; readonly description?: string };
  readonly servers?: ReadonlyArray<{ readonly url: string; readonly description?: string }>;
  readonly tags: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: Readonly<Record<string, Record<string, unknown>>>;
}

const pascal = (kebab: string) => kebab.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
const ref = (section: string, name: string) => ({ $ref: `#/components/${section}/${name}` });

/**
 * Derive the OpenAPI document for a set of contracts. Deterministic: the same contracts always
 * produce the same document, so it can be committed and checked in CI (`projected openapi --check`).
 */
export function openApiDocument(contracts: AnyContracts, options: OpenApiOptions = {}): OpenApiDocument {
  const basePath = (options.basePath ?? "").replace(/\/+$/, "");
  const schemas: Record<string, JsonSchema> = { ...PROTOCOL_SCHEMAS };
  const errorSources = new Map<string, string>();
  const paths: Record<string, unknown> = {};

  /** Convert a zod schema, hoisting any `$defs` into components so references stay resolvable. */
  const component = (name: string, schema: z.ZodType, io: "input" | "output"): { $ref: string } => {
    const converted = z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "throw" }) as JsonSchema;
    const { $schema: _ignored, $defs, ...rest } = converted;
    const rename = (definition: string) => `${name}_${definition}`;
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) =>
          key === "$ref" && typeof inner === "string" && inner.startsWith("#/$defs/")
            ? [key, `#/components/schemas/${rename(inner.slice("#/$defs/".length))}`]
            : key === "$ref" && inner === "#"
              ? [key, `#/components/schemas/${name}`]
              : [key, rewrite(inner)],
        ),
      );
    };
    for (const [definition, value] of Object.entries(($defs ?? {}) as Record<string, unknown>)) {
      schemas[rename(definition)] = rewrite(value) as JsonSchema;
    }
    schemas[name] = rewrite(rest) as JsonSchema;
    return ref("schemas", name);
  };

  const errorComponent = (error: AnyBusinessErrorClass): { $ref: string } => {
    const data = z.toJSONSchema(error.schema, { target: "draft-2020-12", io: "output", unrepresentable: "throw" });
    const fingerprint = JSON.stringify(data);
    const seen = errorSources.get(error.tag);
    if (seen !== undefined && seen !== fingerprint) {
      panic(`openApiDocument: two different errors are tagged ${error.tag}`);
    }
    if (seen === undefined) {
      errorSources.set(error.tag, fingerprint);
      const dataRef = component(`${error.tag}Data`, error.schema, "output");
      schemas[error.tag] = {
        type: "object",
        ...(error.description === undefined ? {} : { description: error.description }),
        required: ["type", "message", "data"],
        additionalProperties: false,
        properties: { type: { const: error.tag }, message: { type: "string" }, data: dataRef },
      };
    }
    return ref("schemas", error.tag);
  };

  const resultSchema = (contract: AnyOperationContract, outputRef: { $ref: string }): JsonSchema => {
    const ok = {
      type: "object",
      required: ["status", "value"],
      additionalProperties: false,
      properties: { status: { const: "ok" }, value: outputRef },
    };
    if (contract.errors.length === 0) return ok;
    const errors = contract.errors.map(errorComponent);
    const error = {
      type: "object",
      required: ["status", "error"],
      additionalProperties: false,
      properties: { status: { const: "error" }, error: errors.length === 1 ? errors[0] : { oneOf: errors } },
    };
    return { oneOf: [ok, error] };
  };

  const batchItems: Record<"command" | "query", { request: JsonSchema[]; result: JsonSchema[] }> = {
    command: { request: [], result: [] },
    query: { request: [], result: [] },
  };

  for (const contract of [...contracts.commands, ...contracts.queries] as AnyOperationContract[]) {
    const name = `${pascal(contract.type)}V${contract.version}`;
    const inputRef = component(`${name}Input`, contract.input, "input");
    const outputRef = component(`${name}Output`, contract.output, "output");
    const result = resultSchema(contract, outputRef);
    const isCommand = contract.kind === "command";

    paths[`${basePath}${operationPath(contract.kind, contract.type, contract.version)}`] = {
      post: {
        operationId: operationId(contract.type, contract.version),
        tags: [PLURAL[contract.kind]],
        ...(contract.summary === undefined ? {} : { summary: contract.summary }),
        ...(contract.description === undefined ? {} : { description: contract.description }),
        ...(contract.deprecated ? { deprecated: true } : {}),
        parameters: [
          ref("parameters", "MessageId"),
          ref("parameters", "CorrelationId"),
          ref("parameters", "CausationId"),
          ...(isCommand ? [ref("parameters", "IdempotencyKey")] : []),
        ],
        requestBody: { required: true, content: { "application/json": { schema: inputRef } } },
        responses: {
          "200": {
            description:
              "The operation ran. `status` is `ok` with the output, or `error` with one of the business errors this operation declares.",
            headers: { [HEADERS.messageId]: ref("headers", "MessageId"), [HEADERS.correlationId]: ref("headers", "CorrelationId") },
            content: { "application/json": { schema: result } },
          },
          "400": ref("responses", "BadRequest"),
          ...(isCommand ? { "409": ref("responses", "ConcurrencyConflict") } : {}),
          "415": ref("responses", "UnsupportedMediaType"),
          "500": ref("responses", "InternalError"),
          "502": ref("responses", "BadGateway"),
          "503": ref("responses", "ServiceUnavailable"),
        },
      },
    };

    batchItems[contract.kind].request.push({
      type: "object",
      required: ["type", "version", "data"],
      additionalProperties: false,
      properties: { type: { const: contract.type }, version: { const: contract.version }, data: inputRef },
    });
    batchItems[contract.kind].result.push(result);
  }

  for (const kind of ["command", "query"] as const) {
    const { request, result } = batchItems[kind];
    if (request.length === 0) continue;
    const plural = PLURAL[kind];
    paths[`${basePath}/${plural}`] = {
      post: {
        operationId: `${kind}Batch`,
        tags: [plural],
        summary: `Run several ${plural} in one request`,
        description: `Items run in order and independently: each has its own outcome, and a failed item does not stop the rest. Not atomic.`,
        parameters: [ref("parameters", "CorrelationId")],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [plural],
                additionalProperties: false,
                properties: { [plural]: { type: "array", items: request.length === 1 ? request[0] : { oneOf: request } } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "One result per item, in order.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["results"],
                  properties: { results: { type: "array", items: { anyOf: [...result, ref("schemas", "FailedBatchItem")] } } },
                },
              },
            },
          },
          "400": ref("responses", "BadRequest"),
          "413": ref("responses", "PayloadTooLarge"),
          "415": ref("responses", "UnsupportedMediaType"),
        },
      },
    };
  }

  paths[`${basePath}/health`] = {
    get: {
      operationId: "health",
      tags: ["system"],
      summary: "Liveness",
      responses: {
        "200": {
          description: "The service is up.",
          content: { "application/json": { schema: { type: "object", properties: { status: { const: "ok" } } } } },
        },
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: options.title ?? contracts.name,
      version: options.version ?? "0.0.0",
      ...(contracts.description === undefined ? {} : { description: contracts.description }),
    },
    ...(options.servers === undefined ? {} : { servers: options.servers }),
    tags: [
      { name: "commands", description: "Business operations that change the system." },
      { name: "queries", description: "Business questions about the system's state." },
      { name: "system", description: "Operational endpoints." },
    ],
    paths,
    components: {
      schemas,
      responses: PROTOCOL_RESPONSES,
      parameters: PROTOCOL_PARAMETERS,
      headers: {
        MessageId: { description: "Id of this request.", schema: { type: "string" } },
        CorrelationId: { description: "Id shared by every message in this business flow.", schema: { type: "string" } },
      },
    },
  };
}

const PROTOCOL_SCHEMAS: Record<string, JsonSchema> = {
  ValidationIssue: {
    type: "object",
    required: ["path", "message"],
    properties: {
      path: { type: "array", items: { type: ["string", "integer"] } },
      message: { type: "string" },
      code: { type: "string" },
    },
  },
  ProblemDetails: {
    type: "object",
    description: "RFC 9457 problem details. Used only for protocol-level failures, never for business outcomes.",
    required: ["type", "title", "status"],
    properties: {
      type: { type: "string", format: "uri" },
      title: { type: "string" },
      status: { type: "integer" },
      detail: { type: "string" },
      issues: { type: "array", items: ref("schemas", "ValidationIssue") },
    },
  },
  FailedBatchItem: {
    type: "object",
    required: ["status", "problem"],
    properties: { status: { const: "failed" }, problem: ref("schemas", "ProblemDetails") },
  },
};

const problemResponse = (description: string, headers?: Record<string, unknown>) => ({
  description,
  ...(headers === undefined ? {} : { headers }),
  content: { "application/problem+json": { schema: ref("schemas", "ProblemDetails") } },
});

const PROTOCOL_RESPONSES: Record<string, unknown> = {
  BadRequest: problemResponse("The body is not valid JSON or does not match the operation's input schema."),
  UnsupportedMediaType: problemResponse("The body is not `application/json`."),
  PayloadTooLarge: problemResponse("The batch has more items than the service accepts."),
  ConcurrencyConflict: problemResponse("The command raced with another change to the same data. Safe to retry."),
  InternalError: problemResponse("A defect in the service. Details are logged, not returned."),
  BadGateway: problemResponse("A dependency of the service answered in a way it cannot handle."),
  ServiceUnavailable: problemResponse("A dependency of the service is unreachable. Retry later.", {
    "retry-after": { description: "Seconds to wait before retrying.", schema: { type: "integer" } },
  }),
};

const header = (name: string, description: string) => ({ name, in: "header", required: false, description, schema: { type: "string" } });

const PROTOCOL_PARAMETERS: Record<string, unknown> = {
  MessageId: header(HEADERS.messageId, "Unique id of this request. Generated when absent."),
  CorrelationId: header(HEADERS.correlationId, "Id shared by every message in one business flow. Defaults to the message id."),
  CausationId: header(HEADERS.causationId, "Id of the message that caused this request."),
  IdempotencyKey: header(
    HEADERS.idempotencyKey,
    "Caller-chosen key identifying this command across retries. Passed to the handler as `metadata.idempotencyKey`.",
  ),
};
