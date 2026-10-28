# Conformance suites

Black-box scenarios for a running projected service: HTTP requests, and what the service must
answer. They are the executable form of [`protocol.md`](../protocol.md), in a form no
implementation language owns — JSON in, JSON out. An implementation conforms when every scenario
passes against it.

| Suite | Holds | Run it against |
|---|---|---|
| [`protocol.json`](protocol.json) | health, the OpenAPI document, routing, problems, message ids, operator-task access | any projected service |
| [`school.json`](school.json) | the reference service's behaviour: business errors, versions, access, idempotency, batches, malformed requests, withdrawal, operator tasks | an implementation of the school, in any language and either flavour |

```sh
projected conformance --url http://localhost:3000                       # protocol
projected conformance --url http://localhost:3000 --suite protocol --suite school
projected conformance --url … --suite ./my-suite.json --token registrar=…
```

## Running the service for it

Scenarios name their callers under `principals`. Start the service with a test authenticator
that accepts `Authorization: Bearer <name>-token` for each, with the permissions listed — the
runner sends exactly that unless `--token <name>=<token>` says otherwise. State may persist
between scenarios: every scenario gets its own ids and dates, so they never see each other's data.

## Scenario format

[`scenario.schema.json`](scenario.schema.json) defines it. A scenario is a list of steps; a step
is a request and what the response must be:

```json
{
  "request": { "method": "POST", "path": "/commands/enlist-student/version/2", "as": "registrar", "body": { "studentId": "s-${id}" } },
  "expect": { "status": 200, "schema": "OperationResult", "body": { "status": "ok", "value": { "studentId": "s-${id}" } } }
}
```

- `request.body` is sent as JSON; `request.raw` as is (for malformed bodies), with the
  `content-type` from `request.headers`. `as` sends the principal's bearer token.
- `expect.status` is a status or a list of acceptable ones. `expect.schema` names a definition in
  [`wire.schema.json`](../wire.schema.json) the body must conform to.
- `expect.headers`: each listed header (any case) must have that value; `"$present"` only
  requires it.
- `expect.body` is matched, not compared:
  - an **object** matches when every key it lists matches — other keys may be there;
  - an **array** matches an array of the same length, element by element;
  - anything else must be equal, after substitution.
- **Placeholders** in strings, anywhere:
  - `${id}` is unique to the scenario, and `${date}` is an ISO date unique to it;
  - `"$any"` matches any value that is there, and `"$string"`, `"$number"` and `"$boolean"`
    match any value of that type;
  - `"$capture:name"` matches any value and keeps it as `${name}` for later steps.

Keep scenarios to what the protocol or the reference service promises: an observable answer,
never an implementation detail. A scenario every implementation has to special-case is a
scenario that is wrong.
