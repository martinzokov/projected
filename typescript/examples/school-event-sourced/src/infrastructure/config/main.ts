import { betterAuthAuthenticator, betterAuthRoutes, betterAuthSecuritySchemes, rolesOf } from "@projected/auth-better-auth";
import { OPERATE } from "@projected/application/event-sourced";
import { httpHandler } from "@projected/http";
import { openTelemetry } from "@projected/opentelemetry";
import { monitorBacklog, randomIds, shutdownGracefully, startPolling, systemClock } from "@projected/runtime";
import { environment } from "./environment.js";
import { corsOrigins, listen, web } from "./web.js";
import { composeSchool } from "./school.js";

const clock = systemClock();
const infrastructure = await environment(clock);
// Spans go wherever the OpenTelemetry SDK sends them; register one (e.g. @opentelemetry/sdk-node) to export.
const telemetry = openTelemetry();

const school = composeSchool({
  ...infrastructure,
  clock,
  ids: randomIds(),
  telemetry,
  onDefect: (defect) => console.error("defect", defect),
  onEventHandlingError: (error, handler) => console.error(`event handler ${handler}`, error.message),
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
const server = await listen(web(api, { corsOrigins: corsOrigins(process.env) }), Number(process.env.PORT ?? 3000));
console.log(`school is listening on ${server.url} — OpenAPI document at ${server.url}/openapi.json`);

// Every event handler catches up in the background too: the relays, and whatever a failed
// inline catch-up left behind.
const poller = startPolling(school, { onError: (error) => console.error("event handling", error.message) });

// Event handler lag, as the projected.event_handler.lag gauge: alert when it keeps growing.
const backlog = monitorBacklog(school, { clock, onError: (error) => console.error("backlog", error.message) });

// On SIGTERM: report draining, give load balancers SHUTDOWN_GRACE_MS to notice, stop taking
// requests, finish those in flight, then close connections.
shutdownGracefully({
  app: school,
  intake: [server, poller, backlog],
  close: infrastructure.close,
  graceMs: Number(process.env.SHUTDOWN_GRACE_MS ?? 0),
  log: (message) => console.log(message),
});
