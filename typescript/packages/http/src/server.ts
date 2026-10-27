import type {
  AnyContracts,
  Application,
  Authenticator,
  Metadata,
  OperationKind,
  OperationResult,
  Principal,
} from "@projected/application";
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
  /**
   * Establishes the principal of each request (e.g. `betterAuthAuthenticator(auth)`). Without
   * one, every request is anonymous and only `access: "public"` operations can run.
   */
  readonly authenticator?: Authenticator;
  /** `WWW-Authenticate` value sent with 401 responses. Defaults to `Bearer`. */
  readonly authenticationChallenge?: string;
  /**
   * Other handlers to serve under path prefixes, checked first — e.g. an auth provider's own
   * sign-in routes: `{ "/api/auth": auth.handler }`.
   */
  readonly routes?: Readonly<Record<string, FetchHandler>>;
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

  const telemetry = app.telemetry;
  const mounts = Object.entries(options.routes ?? {})
    .map(([prefix, handler]) => [prefix.replace(/\/+$/, ""), handler] as const)
    .sort(([a], [b]) => b.length - a.length);

  const metadataFrom = (request: Request, principal: Principal | undefined): Metadata => {
    const header = (name: string) => request.headers.get(name) ?? undefined;
    const messageId = header(HEADERS.messageId) ?? newId();
    return {
      messageId,
      correlationId: header(HEADERS.correlationId) ?? messageId,
      causationId: header(HEADERS.causationId),
      idempotencyKey: header(HEADERS.idempotencyKey),
      ...(principal === undefined ? {} : { principal }),
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

  const challenge = options.authenticationChallenge ?? "Bearer";
  const respondToProblem = (response: Problem, headers: Record<string, string>): Response => {
    const extra: Record<string, string> =
      response.status === 503 ? { "retry-after": "1" } : response.status === 401 ? { "www-authenticate": challenge } : {};
    return json(response, response.status, { ...headers, ...extra });
  };

  const handleOperation = async (request: Request, single: RegExpExecArray | null, batch: RegExpExecArray | null) => {
    const headers = Object.fromEntries([...request.headers].map(([name, value]) => [name.toLowerCase(), value]));
    let principal: Principal | undefined;
    if (options.authenticator !== undefined) {
      const authenticated = await options.authenticator.authenticate({ headers });
      if (authenticated.isErr()) {
        return respondToProblem(problem(PROBLEM_TYPES.dependencyUnavailable, "Service temporarily unavailable", 503), {});
      }
      principal = authenticated.value;
    }
    const metadata = metadataFrom(request, principal);
    const body = await readJson(request);
    if (!body.ok) return json(body.problem, body.problem.status, traceHeaders(metadata));

    if (single !== null) {
      const [, plural = "", type = "", version = "0"] = single;
      const outcome = await runOne(KIND[plural] as OperationKind, type, Number(version), body.body, metadata);
      return outcome.match({
        ok: (result) => json(result, 200, traceHeaders(metadata)),
        err: (error) => respondToProblem(problemForDispatchError(error), traceHeaders(metadata)),
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
      // A batch's Idempotency-Key covers every item: retrying the batch replays each item's outcome.
      const itemMetadata: Metadata = {
        ...metadata,
        messageId: `${metadata.messageId}/${index}`,
        idempotencyKey: metadata.idempotencyKey === undefined ? undefined : `${metadata.idempotencyKey}/${index}`,
      };
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

  return async (request) => {
    const url = new URL(request.url);
    for (const [prefix, handler] of mounts) {
      if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) return handler(request);
    }
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

    const carrier = Object.fromEntries([...request.headers].map(([name, value]) => [name.toLowerCase(), value]));
    const route = single === null ? `/${batch?.[1] ?? ""}` : `/${single[1] ?? ""}/{type}/version/{version}`;
    return telemetry.continueFrom(carrier, () =>
      telemetry.span(
        `POST ${route}`,
        { kind: "server", attributes: { "http.request.method": "POST", "http.route": route, "url.path": url.pathname } },
        async (span) => {
          const response = await handleOperation(request, single, batch);
          span.setAttributes({ "http.response.status_code": response.status });
          if (response.status >= 500) span.fail(`HTTP ${response.status}`);
          return response;
        },
      ),
    );
  };
}

function methodNotAllowed(allow: string): Response {
  return json(problem(PROBLEM_TYPES.methodNotAllowed, "Method not allowed", 405), 405, { allow });
}
