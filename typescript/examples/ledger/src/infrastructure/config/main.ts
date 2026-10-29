import { httpHandler } from "@projected/http";
import { openTelemetry } from "@projected/opentelemetry";
import { jsonLogger, logLevel, monitorBacklog, randomIds, shutdownGracefully, startPolling, systemClock } from "@projected/runtime";
import { auth } from "./auth.js";
import { environment } from "./environment.js";
import { composeLedger } from "./ledger.js";
import { corsOrigins, listen, web } from "./web.js";

const clock = systemClock();
// Spans go wherever the OpenTelemetry SDK sends them; register one (e.g. @opentelemetry/sdk-node) to export.
const telemetry = openTelemetry();
// One JSON line per record on standard output, with the trace it belongs to. LOG_LEVEL: debug, info, warn, error.
const log = jsonLogger({ level: logLevel(process.env.LOG_LEVEL), fields: { service: "ledger" }, telemetry });
const { authenticator, securitySchemes } = auth(process.env);
const infrastructure = await environment(clock);

const app = composeLedger({
  ...infrastructure,
  clock,
  ids: randomIds(),
  telemetry,
  onDefect: (defect) => log.error("defect", { error: defect }),
  onEventHandlingError: (error, handler) => log.warn("event handler fell behind", { handler, error }),
});

const api = httpHandler(app, { authenticator, openApi: { version: "1.0.0", securitySchemes } });
// CORS_ORIGINS lists the browser origins that may call the service; none means the same origin only.
const server = await listen(web(api, { corsOrigins: corsOrigins(process.env), log }), Number(process.env.PORT ?? 3000));
log.info("listening", { url: server.url, openapi: `${server.url}/openapi.json` });

// Transfers are carried out here, in the background, as is whatever a failed inline catch-up
// left behind. Every instance may poll: each step is safe to repeat.
const poller = startPolling(app, { intervalMs: 100, onError: (error) => log.warn("event handling", { error }) });

// Event handler lag, as the projected.event_handler.lag gauge: alert when transfer-process's keeps growing.
const backlog = monitorBacklog(app, { clock, onError: (error) => log.warn("backlog", { error }) });

// On SIGTERM: report draining, give load balancers SHUTDOWN_GRACE_MS to notice, stop taking
// requests, finish those in flight, then close connections.
shutdownGracefully({
  app,
  intake: [server, poller, backlog],
  close: infrastructure.close,
  graceMs: Number(process.env.SHUTDOWN_GRACE_MS ?? 0),
  log: (message) => log.info(message),
});
