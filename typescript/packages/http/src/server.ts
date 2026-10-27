import type { AnyContracts, Application, Metadata, OperationKind, OperationResult } from "@projected/application";
import { openApiDocument, type OpenApiOptions } from "./openapi.js";
import { HEADERS, PLURAL, PROBLEM_TYPES, problem, problemForDispatchError, type Problem } from "./protocol.js";

/** A web-standard request handler: runs on Node (via {@link serve}), Bun, Deno and edge runtimes. */
export type FetchHandler = (request: Request) => Promise<Response>;

export interface HttpHandlerOptions {
  /** Mount point, e.g. `/api`. Defaults to the root. */
  readonly basePath?: string;
  /** Largest accepted batch. Defaults to 100. */
  readonly maxBatchSize?: number;
  /** Serve the OpenAPI document at `GET /openapi.json`. Defaults to true. */
  readonly openApi?: boolean | OpenApiOptions;
  /** Generates message ids for requests without an `X-Message-Id` header. */
  readonly messageIds?: () => string;
}

/** One entry of a batch. A failed entry did not reach a business outcome. */
export type BatchItemResult = OperationResult | { readonly status: "failed"; readonly problem: Problem };

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json", ...headers },
  });

const ROUTE = /^\/(commands|queries)\/([a-z0-9-]+)\/version\/([1-9][0-9]*)$/;
const BATCH = /^\/(commands|queries)$/;
const KIND: Record<string, OperationKind> = { commands: "command", queries: "query" };

/**
 * Serve an application over HTTP. Every route is derived from its contracts:
 *
 * - `POST /commands/{type}/version/{version}` — run one command; the body is its input
 * - `POST /queries/{type}/version/{version}` — run one query
 * - `POST /commands`, `POST /queries` — run a batch: `{ "commands": [{ type, version, data }] }`
 * - `GET /openapi.json` — the OpenAPI 3.1 document
 * - `GET /health` — liveness
 */
export function httpHandler<C extends AnyContracts>(app: Application<C>, options: HttpHandlerOptions = {}): FetchHandler {
  const basePath = (options.basePath ?? "").replace(/\/+$/, "");
  const maxBatchSize = options.maxBatchSize ?? 100;
  const newId = options.messageIds ?? (() => crypto.randomUUID());
  const openApiOptions = typeof options.openApi === "object" ? options.openApi : {};
  const document = options.openApi === false ? undefined : openApiDocument(app.contracts, openApiOptions);

  const metadataFrom = (request: Request): Metadata => {
    const header = (name: string) => request.headers.get(name) ?? undefined;
    const messageId = header(HEADERS.messageId) ?? newId();
    return {
      messageId,
      correlationId: header(HEADERS.correlationId) ?? messageId,
      causationId: header(HEADERS.causationId),
      idempotencyKey: header(HEADERS.idempotencyKey),
    };
  };

  const traceHeaders = (metadata: Metadata) => ({
    [HEADERS.messageId]: metadata.messageId,
    [HEADERS.correlationId]: metadata.correlationId,
  });

  const readJson = async (request: Request): Promise<{ ok: true; body: unknown } | { ok: false; problem: Problem }> => {
    const contentType = request.headers.get("content-type") ?? "";
    const text = await request.text();
    if (text.trim() === "") return { ok: true, body: {} };
    if (!/^application\/([a-z.+-]*\+)?json\b/i.test(contentType)) {
      return {
        ok: false,
        problem: problem(PROBLEM_TYPES.unsupportedMediaType, "Unsupported media type", 415, "Send application/json"),
      };
    }
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, problem: problem(PROBLEM_TYPES.malformedRequest, "Malformed request", 400, "Body is not valid JSON") };
    }
  };

  const runOne = async (kind: OperationKind, type: string, version: number, input: unknown, metadata: Metadata) =>
    app.dispatch({ kind, type, version, input, metadata });

  return async (request) => {
    const url = new URL(request.url);
    if (basePath !== "" && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return json(problem(PROBLEM_TYPES.notFound, "Not found", 404), 404);
    }
    const path = url.pathname.slice(basePath.length) || "/";

    if (path === "/health") {
      return request.method === "GET" ? json({ status: "ok" }, 200) : methodNotAllowed("GET");
    }
    if (path === "/openapi.json" && document !== undefined) {
      return request.method === "GET" ? json(document, 200) : methodNotAllowed("GET");
    }

    const single = ROUTE.exec(path);
    const batch = single === null ? BATCH.exec(path) : null;
    if (single === null && batch === null) return json(problem(PROBLEM_TYPES.notFound, "Not found", 404), 404);
    if (request.method !== "POST") return methodNotAllowed("POST");

    const metadata = metadataFrom(request);
    const body = await readJson(request);
    if (!body.ok) return json(body.problem, body.problem.status, traceHeaders(metadata));

    if (single !== null) {
      const [, plural = "", type = "", version = "0"] = single;
      const outcome = await runOne(KIND[plural] as OperationKind, type, Number(version), body.body, metadata);
      return outcome.match({
        ok: (result) => json(result, 200, traceHeaders(metadata)),
        err: (error) => {
          const response = problemForDispatchError(error);
          const retry: Record<string, string> = response.status === 503 ? { "retry-after": "1" } : {};
          return json(response, response.status, { ...traceHeaders(metadata), ...retry });
        },
      });
    }

    const [, plural = ""] = batch ?? [];
    const kind = KIND[plural] as OperationKind;
    const items = (body.body as Record<string, unknown> | null)?.[PLURAL[kind]];
    if (!Array.isArray(items)) {
      return json(
        problem(PROBLEM_TYPES.malformedRequest, "Malformed request", 400, `Expected { "${PLURAL[kind]}": [...] }`),
        400,
        traceHeaders(metadata),
      );
    }
    if (items.length > maxBatchSize) {
      return json(
        problem(PROBLEM_TYPES.payloadTooLarge, "Batch too large", 413, `At most ${maxBatchSize} items per batch`),
        413,
        traceHeaders(metadata),
      );
    }
    const results: BatchItemResult[] = [];
    for (const [index, item] of items.entries()) {
      const { type, version, data } = (item ?? {}) as { type?: unknown; version?: unknown; data?: unknown };
      if (typeof type !== "string" || typeof version !== "number") {
        results.push({
          status: "failed",
          problem: problem(PROBLEM_TYPES.malformedRequest, "Malformed batch item", 400, `Item ${index} needs type and version`),
        });
        continue;
      }
      const itemMetadata: Metadata = { ...metadata, messageId: `${metadata.messageId}/${index}`, idempotencyKey: undefined };
      const outcome = await runOne(kind, type, version, data ?? {}, itemMetadata);
      results.push(
        outcome.match<BatchItemResult>({
          ok: (result) => result,
          err: (error) => ({ status: "failed", problem: problemForDispatchError(error) }),
        }),
      );
    }
    return json({ results }, 200, traceHeaders(metadata));
  };
}

function methodNotAllowed(allow: string): Response {
  return json(problem(PROBLEM_TYPES.methodNotAllowed, "Method not allowed", 405), 405, { allow });
}
