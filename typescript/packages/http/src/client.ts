import {
  DependencyFailure,
  DependencyUnavailable,
  Result,
  TaggedError,
  decodeWireError,
  propagate,
  type AnyContracts,
  type AnyOperationContract,
  type ErrorOf,
  type ExecutionContext,
  type InfrastructureError,
  type OutputOf,
  type RemoteService,
} from "@projected/application";
import type { z } from "zod";
import { HEADERS, operationPath } from "./protocol.js";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpServiceOptions {
  /** Base URL of the remote service, including any base path: `https://school.internal/api`. */
  readonly baseUrl: string;
  /** Defaults to the global `fetch`. Pass a handler-backed function to test without a network. */
  readonly fetch?: Fetch;
  /** Extra headers for every request, e.g. authorization. */
  readonly headers?: () => Record<string, string>;
  /** Per-request timeout. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
}

/**
 * A {@link RemoteService} over HTTP: call another projected service's commands and queries with
 * types taken from its contracts. Business errors come back as instances of the contract's error
 * classes; every transport problem becomes an infrastructure error.
 *
 * ```ts
 * const school = httpService(schoolContracts, { baseUrl: "http://school:3000" });
 * const enlisted = await school.execute(EnlistStudent, { firstname: "Bruce", ... }, context);
 * ```
 */
export function httpService<C extends AnyContracts>(contracts: C, options: HttpServiceOptions): RemoteService<C> {
  const dependency = contracts.name;
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;

  const unavailable = (message: string, cause?: unknown) =>
    new DependencyUnavailable({ dependency, message: `${dependency}: ${message}`, cause });
  const failure = (message: string, cause?: unknown) =>
    new DependencyFailure({ dependency, message: `${dependency}: ${message}`, cause });

  const execute = async <Op extends AnyOperationContract>(
    contract: Op,
    input: unknown,
    context?: ExecutionContext,
  ): Promise<Result<OutputOf<Op>, ErrorOf<Op> | InfrastructureError>> => {
    const metadata = propagate(context);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...options.headers?.(),
      ...(metadata.correlationId === undefined ? {} : { [HEADERS.correlationId]: metadata.correlationId }),
      ...(metadata.causationId === undefined ? {} : { [HEADERS.causationId]: metadata.causationId }),
    };
    const sent = await Result.tryPromise({
      try: () =>
        doFetch(`${baseUrl}${operationPath(contract.kind, contract.type, contract.version)}`, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      catch: (cause) => unavailable("request failed", cause),
    });
    if (sent.isErr()) return Result.err(sent.error);
    const response = sent.value;

    if (response.status !== 200) {
      // 409 means the remote raced another change; 429/503/504 mean "later". All retryable.
      if ([409, 429, 503, 504].includes(response.status)) return Result.err(unavailable(`HTTP ${response.status}`));
      return Result.err(failure(`HTTP ${response.status}: ${await response.text().catch(() => "")}`));
    }
    const body = await Result.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) => failure("response is not JSON", cause),
    });
    if (body.isErr()) return Result.err(body.error);
    const result = body.value as { status?: unknown; value?: unknown; error?: unknown };

    if (result.status === "ok") {
      const output = contract.output.safeParse(result.value);
      return output.success
        ? Result.ok(output.data as OutputOf<Op>)
        : Result.err(failure("output does not match the contract", output.error));
    }
    if (result.status === "error") {
      const error = decodeWireError(contract, result.error);
      return error === undefined ? Result.err(failure("returned an undeclared error", result.error)) : Result.err(error);
    }
    return Result.err(failure("response is not an operation result"));
  };

  return { contracts, execute } as RemoteService<C>;
}

/** A third-party API answered with a status the caller asked to treat as data. */
export class HttpStatusError extends TaggedError("HttpStatusError")<{
  status: number;
  body: unknown;
  message: string;
}> {}

export interface HttpRequest<S extends z.ZodType> {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path relative to the client's base URL. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Serialized as JSON. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Schema the success body must match. Mismatches are a {@link DependencyFailure}. */
  readonly response: S;
  /** Statuses returned as {@link HttpStatusError} instead of a failure — e.g. `[404]` to model "not found". */
  readonly expectedErrors?: readonly number[];
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

/** Result-based HTTP client for driven adapters that wrap third-party APIs. */
export interface HttpClient {
  request<S extends z.ZodType>(
    request: HttpRequest<S>,
  ): Promise<Result<HttpResponse<z.output<S>>, HttpStatusError | DependencyUnavailable | DependencyFailure>>;
}

export interface HttpClientOptions {
  /** Name used in errors and logs: `"payments"`. */
  readonly dependency: string;
  readonly baseUrl: string;
  readonly fetch?: Fetch;
  readonly headers?: () => Record<string, string>;
  readonly timeoutMs?: number;
}

/**
 * Create an {@link HttpClient}. Use it inside a driven adapter that implements one of your own
 * ports, so the application never sees HTTP:
 *
 * ```ts
 * export const stripePayments = (http: HttpClient): PaymentGateway => ({
 *   charge: async (amount) =>
 *     (await http.request({ method: "POST", path: "/charges", body: amount, response: Charge }))
 *       .map(({ body }) => ({ chargeId: body.id })),
 * });
 * ```
 */
export function httpClient(options: HttpClientOptions): HttpClient {
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const { dependency } = options;

  return {
    request: async (request) => {
      const url = new URL(`${baseUrl}/${request.path.replace(/^\/+/, "")}`);
      for (const [key, value] of Object.entries(request.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      const sent = await Result.tryPromise({
        try: () =>
          doFetch(url, {
            method: request.method,
            headers: {
              accept: "application/json",
              ...(request.body === undefined ? {} : { "content-type": "application/json" }),
              ...options.headers?.(),
              ...request.headers,
            },
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            signal: AbortSignal.timeout(timeoutMs),
          }),
        catch: (cause) => new DependencyUnavailable({ dependency, message: `${dependency}: request failed`, cause }),
      });
      if (sent.isErr()) return Result.err(sent.error);
      const response = sent.value;
      const text = await response.text().catch(() => "");
      const parsed = (() => {
        if (text === "") return undefined;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      })();

      if (!response.ok) {
        if (request.expectedErrors?.includes(response.status)) {
          return Result.err(
            new HttpStatusError({ status: response.status, body: parsed, message: `${dependency}: HTTP ${response.status}` }),
          );
        }
        const retryable = [408, 429, 502, 503, 504].includes(response.status);
        const message = `${dependency}: HTTP ${response.status}`;
        return Result.err(
          retryable
            ? new DependencyUnavailable({ dependency, message })
            : new DependencyFailure({ dependency, message, cause: parsed }),
        );
      }
      const body = request.response.safeParse(parsed);
      if (!body.success) {
        return Result.err(
          new DependencyFailure({ dependency, message: `${dependency}: unexpected response body`, cause: body.error }),
        );
      }
      return Result.ok({ status: response.status, headers: response.headers, body: body.data });
    },
  };
}
