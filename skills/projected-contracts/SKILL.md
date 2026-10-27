---
name: projected-contracts
description: "Use when adding, changing, versioning, deprecating or naming a command or query in a projected app (files in src/application/port/driving), when deciding what an operation returns or which business errors it declares, or when explaining how its HTTP endpoint and OpenAPI document come about."
category: software-development
---

# Commands, queries and their contracts

A contract is the whole public API of one business operation at one version. HTTP routes,
request validation, the OpenAPI document, typed clients, message envelopes and the contract
lock are all derived from it. You never write any of those by hand.

The approach is Sollecito's *It's time to put REST to rest*: APIs expose business operations,
`POST /commands/{type}/version/{n}` and `POST /queries/{type}/version/{n}`, and HTTP status codes
describe the HTTP exchange — never the business outcome.

## Defining one

```ts
// src/application/port/driving/enlist-student.ts
import { defineCommand, z } from "@projected/application";
import { StudentAlreadyEnlisted } from "../../../domain/student/errors.js";

export const EnlistStudentV2 = defineCommand({
  type: "enlist-student",          // kebab-case business intent → the URL
  version: 2,                      // defaults to 1
  summary: "Enlist a new student", // OpenAPI summary; description and deprecated are optional
  input: z.object({ studentId: z.string().min(1), firstname: z.string().trim().min(1), lastname: z.string().trim().min(1), joiningDate: z.iso.date() }),
  output: z.object({ studentId: z.string() }),
  errors: [StudentAlreadyEnlisted], // every business error the handler may return
  access: { permissions: ["students:manage"] }, // optional: overrides the service default
});
```

`defineQuery` takes the same options. Then list it in the service's contracts:

```ts
// src/application/port/driving/index.ts
export const schoolContracts = defineContracts({
  name: "school",
  access: "authenticated",          // required: who may call operations that set no `access`
  commands: [EnlistStudentV1, EnlistStudentV2, ReportStudentLastnameChange],
  queries: [EnlistedStudentsOnJoiningDate, StudentProfile],
});
```

## Command or query?

| | Command | Query |
|---|---|---|
| Purpose | change the system | answer a question |
| Writes events | yes, through an aggregate | never |
| Reads from | the aggregate it changes | a read model (projection) or an aggregate |
| Safe to retry | when idempotent — design for it | always |

## Naming

Name the business intent, from the domain's own vocabulary: `enlist-student`, `place-limit-order`,
`report-student-lastname-change`. Never CRUD verbs on data (`create-`, `update-`, `delete-`,
`set-`, `patch-`, `get-`). A query names the question: `enlisted-students-on-joining-date`,
not `students`. Two business reasons for the same data change are two commands.

## Who may call it

Every service declares a default `access` in `defineContracts`, and each operation may override it:

| `access` | Allows |
|---|---|
| `"public"` | anyone, anonymous included — say so deliberately |
| `"authenticated"` | any signed-in principal |
| `{ permissions: ["students:manage"] }` | principals holding every listed permission (`resource:action`) |

The dispatcher enforces it for HTTP and messaging alike (401/403 before input is even
validated). Rules that depend on data — "only the student's own tutor" — are business rules: read
`context.metadata.principal` in the handler and return a declared business error. Access is part
of the published contract: tightening it on a published version is a new version.

## Designing the output

- Return what the caller needs next (usually an id, or a summary of what changed), not the whole
  aggregate.
- "Nothing found" is usually a normal answer, not an error: `output: z.object({ student: Student.nullable() })`.
  The request was fine and the answer is "none".
- Report idempotent no-ops in the output (`{ changed: false }`) rather than as errors.

## Declaring errors

`errors` lists the business errors (from `defineError`) a caller can receive and act on. The
type system holds the handler to it: returning an undeclared business error **does not compile**,
so the OpenAPI document is always complete. Infrastructure errors (`DependencyUnavailable`,
`ConcurrencyConflict`, `DependencyFailure`) are never declared — the transport maps them to
protocol responses.

If a decision can return an error that cannot actually happen for this operation (e.g.
`StudentAlreadyEnlisted` when the id was just generated), map it to a defect in the handler
instead of declaring it:

```ts
.mapError((error) => (StudentAlreadyEnlisted.is(error) ? panic("generated id collided", error) : error))
```

## Versions are immutable

Once an operation is published (in `contracts.lock.json`), its input, output and errors never
change. `projected check` fails if they do. To evolve it:

1. Copy it as `version: N + 1` with the new shape. Keep the old one.
2. Mark the old one `deprecated: true` and say why in its `description`.
3. Bind both versions in the composition root; both handlers usually call the same decision.
4. `projected contracts --update` to lock the new version, `projected openapi` to regenerate.
5. Remove the old version only when no client uses it:
   `projected contracts --update --allow-removal`.

Documentation (summary, description, `.describe()` on fields) may change freely: it is not part
of the fingerprint. Adding a field — even an optional one — is a new version.

## What the HTTP binding does with it

| Outcome | Response |
|---|---|
| handler returned output | `200 {"status":"ok","value":{...}}` |
| handler returned a declared business error | `200 {"status":"error","error":{"type":"StudentAlreadyEnlisted","message":"...","data":{...}}}` |
| caller not signed in / lacks a permission | `401` / `403` problem details |
| input fails the schema | `400` problem details with `issues` |
| same `Idempotency-Key` still running / reused for other input | `409` / `422` problem details |
| unknown type or version | `404` problem details |
| concurrency conflict after retries | `409` problem details |
| dependency unreachable / broken | `503` (with `Retry-After`) / `502` |
| bug (throw, undeclared error, output mismatch) | `500`, no details |

Every operation can also be sent in a batch (`POST /commands` with `{"commands":[{type, version, data}]}`)
and through a message queue, unchanged. The normative description is `spec/protocol.md`.

## Checklist

- [ ] kebab-case business name; not a CRUD verb
- [ ] input validates everything the handler relies on (`.min(1)`, `.trim()`, `z.iso.date()`)
- [ ] output is what the caller needs; "not found" is `null`, not an error
- [ ] every business error the handler can return is in `errors`
- [ ] `access` is right: inherited default, or a deliberate override
- [ ] listed in `defineContracts`, bound in the composition root
- [ ] `projected openapi` and `projected contracts --update` run, results committed
- [ ] a published version was not edited — a new version was added instead
