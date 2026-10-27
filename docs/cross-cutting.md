# Authentication, duplicate protection and tracing

Three concerns that every operation needs and no use case should implement. Each is a port in
`@projected/application`, enforced or recorded by the dispatcher, so it applies identically to
HTTP, batches and queued commands.

## Authentication and access

**Who** sent a request is established by an `Authenticator` at the edge; **whether** they may run
an operation is the operation's `access` rule, checked by the dispatcher before anything else.

```ts
export const EnlistStudentV2 = defineCommand({
  type: "enlist-student",
  version: 2,
  access: { permissions: ["students:manage"] },        // overrides the service default
  ...
});

export const schoolContracts = defineContracts({
  name: "school",
  access: "authenticated",                              // required: a visible decision per service
  commands: [...],
});
```

- `"public"`, `"authenticated"` or `{ permissions: [...] }`; anything finer ("only the student's
  own tutor") is a business rule in the handler, using `context.metadata.principal`.
- Refusals are `Unauthenticated` (401, with `WWW-Authenticate`) and `Forbidden` (403), checked
  before input validation.
- The access rule is part of the contract: it is in the OpenAPI document (`x-projected-access`,
  `security`, 401/403 responses) and in the contract lock, so tightening a published operation
  is caught like any other breaking change.
- The principal is recorded on every event as `metadata.principalId` — an audit trail.

### better-auth

`@projected/auth-better-auth` turns a better-auth session (cookie, or bearer token with the
bearer plugin) into a principal, maps the admin plugin's roles to permissions, serves
better-auth's own routes next to the operations, and documents both schemes in OpenAPI:

```ts
const auth = betterAuth({ database: pool, emailAndPassword: { enabled: true }, plugins: [bearer(), admin()] });

httpHandler(app, {
  authenticator: betterAuthAuthenticator(auth, { roles: { admin: ["students:manage"] } }),
  routes: betterAuthRoutes(auth),                                   // /api/auth/*
  openApi: { securitySchemes: betterAuthSecuritySchemes() },
});
```

`permissions: (session) => [...]` derives permissions any other way (organizations, teams).

### Other providers

An authenticator is one function from request headers to a principal, so each provider is a
small package: `@projected/auth-<provider>`. Likely next: a generic JWT/OIDC authenticator (JWKS
verification with `jose`) covering Auth0, Clerk, WorkOS, Cognito and Keycloak in one adapter;
then provider-specific packages where claims need mapping. Tests use `tokenAuthenticator` from
`@projected/testing`.

## Duplicate command protection

Configure an `IdempotencyStore` and commands sent with an idempotency key run at most once per key
and principal:

```ts
createApplication(contracts, { idempotency: { store: postgresIdempotencyStore(sql) }, ... });
```

| Request | Outcome |
|---|---|
| first with key K | runs; its business outcome is stored |
| same K, same input | the stored outcome, replayed — the handler does not run |
| same K, different input | `IdempotencyKeyReused` (422) |
| same K while the first is running | `RequestInProgress` (409, retry later) |
| first failed for infrastructure reasons | nothing stored; retrying with K runs again |

- Over HTTP the key is the `Idempotency-Key` header (batches protect each item); for queued
  commands it is the message id, so broker redeliveries are absorbed automatically.
- Keys are scoped to the principal; the request fingerprint is SHA-256 of canonical JSON, the
  same in every language (`spec/protocol.md` §2.2).
- Queries ignore keys. Design commands to be idempotent anyway (caller-chosen ids, "already
  done" as a no-op) — the store protects against retries, good design against everything else.

## Tracing

`createApplication({ telemetry: openTelemetry() })` records:

| Span | Kind | From |
|---|---|---|
| `POST /commands/{type}/version/{version}` | server | HTTP handler, continuing the caller's `traceparent` |
| `command enlist-student@2` | internal | dispatcher: outcome, error type, principal, ids |
| `execute student` / `load student` | internal | aggregate repository (pass `telemetry` to it) |
| `student-directory StudentEnlisted` | consumer | each event handled, continuing the command's trace |
| `send school/notify-parent@1` | producer | command queue, trace in message headers |
| `receive school.commands` | consumer | message consumer, continuing the producer's trace |
| `command school/enlist-student@2` | client | `httpService` calls, `traceparent` sent along |

Because the dispatch span's context is stored in each event's metadata, projections, relays and
other services' consumers continue the original request's trace, however much later they run.
`@projected/opentelemetry` uses the global OpenTelemetry API: register an SDK (e.g.
`@opentelemetry/sdk-node` with an OTLP exporter) and spans flow to your backend; without one it is
a no-op. Tests use `recordingTelemetry` from `@projected/testing`.
