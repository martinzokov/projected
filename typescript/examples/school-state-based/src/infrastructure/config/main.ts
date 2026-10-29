import { betterAuthAuthenticator, betterAuthRoutes, betterAuthSecuritySchemes, rolesOf } from "@projected/auth-better-auth";
import { OPERATE } from "@projected/application/state-based";
import { httpHandler } from "@projected/http";
import { openTelemetry } from "@projected/opentelemetry";
import { jsonLogger, logLevel, monitorBacklog, randomIds, shutdownGracefully, startOutboxPruning, startPolling, systemClock } from "@projected/runtime";
import { environment } from "./environment.js";
import { corsOrigins, listen, web } from "./web.js";
import { composeSchool } from "./school.js";

const clock = systemClock();
// Spans go wherever the OpenTelemetry SDK sends them; register one (e.g. @opentelemetry/sdk-node) to export.
const telemetry = openTelemetry();
// One JSON line per record on standard output, with the trace it belongs to. LOG_LEVEL: debug, info, warn, error.
const log = jsonLogger({ level: logLevel(process.env.LOG_LEVEL), fields: { service: "school" }, telemetry });
const infrastructure = await environment(clock, log);

const school = composeSchool({
  ...infrastructure,
  clock,
  ids: randomIds(),
  telemetry,
  onDefect: (defect) => log.error("defect", { error: defect }),
  onEventHandlingError: (error, handler) => log.warn("event handler fell behind", { handler, error }),
});

// Registrars manage enrolment and operate the service (`projected operate`): users with
// better-auth's admin role, or listed in SCHOOL_ADMINS.
const admins = (process.env.SCHOOL_ADMINS ?? "").split(",").filter((email) => email !== "");
const authenticator = betterAuthAuthenticator(infrastructure.auth, {
  permissions: (session) =>
    rolesOf(session).includes("admin") || admins.includes(session.user.email ?? "") ? ["students:manage", OPERATE] : [],
});

const api = httpHandler(school, {
  authenticator,
  routes: betterAuthRoutes(infrastructure.auth),
  openApi: { version: "1.0.0", securitySchemes: betterAuthSecuritySchemes() },
});
// CORS_ORIGINS lists the browser origins that may call the service; none means the same origin only.
const server = await listen(web(api, { corsOrigins: corsOrigins(process.env), log }), Number(process.env.PORT ?? 3000));
log.info("listening", { url: server.url, openapi: `${server.url}/openapi.json` });

// Every event handler catches up in the background too: the relays, and whatever a failed
// inline catch-up left behind.
const poller = startPolling(school, { onError: (error) => log.warn("event handling", { error }) });

// Event handler lag, as the projected.event_handler.lag gauge: alert when it keeps growing.
const backlog = monitorBacklog(school, { clock, onError: (error) => log.warn("backlog", { error }) });

// Hourly, delete outbox events every handler and relay has passed once they are 30 days old.
const pruner = startOutboxPruning(school, infrastructure.stateStore, {
  clock,
  onPruned: (count) => log.info("outbox pruned", { count }),
  onError: (error) => log.warn("outbox pruning", { error }),
});

// On SIGTERM: report draining, give load balancers SHUTDOWN_GRACE_MS to notice, stop taking
// requests, finish those in flight, then close connections.
shutdownGracefully({
  app: school,
  intake: [server, poller, backlog, pruner],
  close: infrastructure.close,
  graceMs: Number(process.env.SHUTDOWN_GRACE_MS ?? 0),
  log: (message) => log.info(message),
});
