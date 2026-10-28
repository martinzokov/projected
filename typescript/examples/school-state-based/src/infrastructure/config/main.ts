import { betterAuthAuthenticator, betterAuthRoutes, betterAuthSecuritySchemes, rolesOf } from "@projected/auth-better-auth";
import { httpHandler } from "@projected/http";
import { serve } from "@projected/http/node";
import { openTelemetry } from "@projected/opentelemetry";
import { monitorBacklog, randomIds, shutdownGracefully, systemClock } from "@projected/runtime";
import { environment } from "./environment.js";
import { composeSchool } from "./school.js";

const clock = systemClock();
const infrastructure = await environment(clock);
// Spans go wherever the OpenTelemetry SDK sends them; register one (e.g. @opentelemetry/sdk-node) to export.
const telemetry = openTelemetry();

const school = composeSchool({ ...infrastructure, clock, ids: randomIds(), telemetry, onDefect: (defect) => console.error("defect", defect) });

// Registrars manage enrolment: users with better-auth's admin role, or listed in SCHOOL_ADMINS.
const admins = (process.env.SCHOOL_ADMINS ?? "").split(",").filter((email) => email !== "");
const authenticator = betterAuthAuthenticator(infrastructure.auth, {
  permissions: (session) =>
    rolesOf(session).includes("admin") || admins.includes(session.user.email ?? "") ? ["students:manage"] : [],
});

const server = await serve(
  httpHandler(school, {
    authenticator,
    routes: betterAuthRoutes(infrastructure.auth),
    openApi: { version: "1.0.0", securitySchemes: betterAuthSecuritySchemes() },
  }),
  { port: Number(process.env.PORT ?? 3000) },
);
console.log(`school is listening on ${server.url} — OpenAPI document at ${server.url}/openapi.json`);

// Event handler lag, as the projected.event_handler.lag gauge: alert when it keeps growing.
const backlog = monitorBacklog(school, { clock, onError: (error) => console.error("backlog", error.message) });

// On SIGTERM: report draining, give load balancers SHUTDOWN_GRACE_MS to notice, stop taking
// requests, finish those in flight, then close connections.
shutdownGracefully({
  app: school,
  intake: [server, backlog],
  close: infrastructure.close,
  graceMs: Number(process.env.SHUTDOWN_GRACE_MS ?? 0),
  log: (message) => console.log(message),
});
