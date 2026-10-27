/**
 * @projected/http — the HTTP driving and driven adapters. Import it only from
 * `src/infrastructure/**`: the architecture rules reject it anywhere else.
 */
export { httpHandler, type BatchItemResult, type FetchHandler, type HttpHandlerOptions } from "./server.js";
export { openApiDocument, type OpenApiDocument, type OpenApiOptions } from "./openapi.js";
export {
  HttpStatusError,
  httpClient,
  httpService,
  type HttpClient,
  type HttpClientOptions,
  type HttpRequest,
  type HttpResponse,
  type HttpServiceOptions,
} from "./client.js";
export { serve, type RunningServer, type ServeOptions } from "./node.js";
export {
  HEADERS,
  PROBLEM_TYPES,
  operationId,
  operationPath,
  problemForDispatchError,
  type Problem,
} from "./protocol.js";
