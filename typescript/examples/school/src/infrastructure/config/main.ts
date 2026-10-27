import { betterAuthAuthenticator, betterAuthRoutes, betterAuthSecuritySchemes } from "@projected/auth-better-auth";
import { httpHandler } from "@projected/http";
import { serve } from "@projected/http/node";
import { openTelemetry } from "@projected/opentelemetry";
import { randomIds, systemClock } from "@projected/runtime";
import { environment } from "./environment.js";
import { composeSchool } from "./school.js";

const clock = systemClock();
const infrastructure = await environment(clock);
// Spans go wherever the OpenTelemetry SDK sends them; register one (e.g. @opentelemetry/sdk-node) to export.
const telemetry = openTelemetry();

const school = composeSchool({ ...infrastructure, clock, ids: randomIds(), telemetry, onDefect: (defect) => console.error("defect", defect) });

const server = await serve(
  httpHandler(school, {
    authenticator: betterAuthAuthenticator(infrastructure.auth, { roles: { admin: ["students:manage"] } }),
    routes: betterAuthRoutes(infrastructure.auth),
    openApi: { version: "1.0.0", securitySchemes: betterAuthSecuritySchemes() },
  }),
  { port: Number(process.env.PORT ?? 3000) },
);
console.log(`school is listening on ${server.url} — OpenAPI document at ${server.url}/openapi.json`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void server.close().then(infrastructure.close).then(() => process.exit(0)));
}
