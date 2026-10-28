# Third-party APIs: `projected vendor`

Calling someone else's HTTP API takes three pieces. Only one of them is mechanical, and that is
the one `projected vendor` writes:

| Piece | Where | Written by |
|---|---|---|
| A **port** in the application's own words (`Weather.forecastFor(place)`) | `src/application/port/driven/<name>.ts` | you — it is a design decision |
| The vendor's **schemas and a typed client** | `src/infrastructure/adapter/driven/<name>/<name>-client.ts` | `projected vendor`, from the vendor's OpenAPI spec |
| An **adapter** mapping one onto the other | `src/infrastructure/adapter/driven/<name>/<name>-adapter.ts` | you |

The port and the mapping are deliberately hand-written: they are the translation layer that
keeps vendor names (`temperature_2m_max`) and vendor shapes out of the application.

## Workflow

```sh
projected vendor add weather --spec https://api.weather.example/openapi.yaml   # or a file
```

This pins the spec as `vendor/weather.openapi.json`, generates the client, records the vendor in
`projected.json`, and — once, only if they do not exist — writes a starter port and adapter:

```json
{ "vendors": { "weather": { "spec": "vendor/weather.openapi.json", "source": "https://api.weather.example/openapi.yaml" } } }
```

Then describe what the application needs, and map it:

```ts
// src/application/port/driven/weather.ts
export interface Weather {
  forecastFor(place: { lat: number; lon: number }): Promise<Result<readonly DailyForecast[], DependencyUnavailable | DependencyFailure>>;
}

// src/infrastructure/adapter/driven/weather/weather-adapter.ts
export const weatherAdapter = (client: WeatherClient): Weather => ({
  forecastFor: async ({ lat, lon }) =>
    (await client.getForecast({ latitude: lat, longitude: lon })).map(({ body }) =>
      body.daily.map((day) => ({ date: day.date, maxTempC: day.maxTempC })),
    ),
});

// composition root
const weather = weatherAdapter(weatherClient(httpClient({ dependency: "weather", baseUrl: WEATHER_BASE_URL, telemetry })));
```

Every generated method calls projected's `httpClient`, so it is traced, times out, sends
`traceparent`, validates the response against the vendor's schema, and returns a Result:
network failures, timeouts and 5xx are `DependencyUnavailable`, a body that breaks the spec is
`DependencyFailure`. Pass `{ expectedErrors: [404] }` to receive those statuses as
`HttpStatusError` — the type only includes it when you do — and turn them into outcomes in the
adapter.

| Command | Does |
|---|---|
| `projected vendor add <name> --spec <url\|file>` | pin, generate, start the port and adapter |
| `projected vendor update <name> [--spec <url\|file>]` | take the vendor's new spec: shows every change, and refuses breaking ones |
| `projected vendor update <name> --accept-breaking` | take it anyway; then fix what no longer compiles |
| `projected vendor generate [<name>]` | regenerate clients from the pinned specs (after upgrading projected) |
| `projected check` | fails if a generated client does not match its pinned spec |

## What counts as breaking

`vendor update` compares the pinned spec with the new one, operation by operation (by method and
path, so a renamed `operationId` is not a removal), and reports a change as breaking when code
generated from the old spec could fail against the new API:

- an operation was removed, or no longer returns JSON;
- a new required parameter or request body field, a parameter that became required, a request
  field that no longer accepts a value it used to (a removed enum value, `null`, a type change);
- a response field the old schema requires was removed or became optional, changed type, may
  now be `null`, or gained enum values the old schema would reject.

Additions — operations, optional parameters, response fields — are listed but not breaking.
Response objects are parsed tolerantly: unknown fields are stripped, never rejected.

## Supported OpenAPI

OpenAPI 3.0 and 3.1, JSON or YAML. JSON request and response bodies (the first of 200, 201,
202, 203, 2XX or default is the success body); path, query and header parameters (query arrays
are sent comma-separated); schemas made of objects, arrays, primitives, enums, `const`,
nullable types, `oneOf`/`anyOf`/`allOf` and local `$ref`s, recursive ones included. Anything else
— form bodies, cookies, remote `$ref`s, Swagger 2 — degrades to `z.unknown()` or is rejected with
a message saying what to do. Generated files are never edited by hand; `projected check` keeps
them honest.
