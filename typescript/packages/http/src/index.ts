/**
 * @projected/http — the HTTP driving and driven adapters. Import it only from
 * `src/infrastructure/**`: the architecture rules reject it anywhere else.
 *
 * Everything here is web-standard (Request, Response, fetch) and runs on Node, Bun, Deno and
 * edge runtimes. The Node server lives in `@projected/http/node`.
 */
export { httpHandler, type BatchItemResult, type FetchHandler, type HttpHandlerOptions } from "./server.js";
export { openApiDocument, type OpenApiDocument, type OpenApiOptions } from "./openapi.js";
export {
  HttpStatusError,
  httpClient,
  httpService,
  type ExpectedStatuses,
  type HttpClient,
  type HttpClientOptions,
  type HttpRequest,
  type HttpRequestError,
  type HttpResponse,
  type HttpServiceOptions,
} from "./client.js";
export {
  HEADERS,
  PROBLEM_TYPES,
  operationId,
  operationPath,
  problemForDispatchError,
  type Problem,
} from "./protocol.js";
