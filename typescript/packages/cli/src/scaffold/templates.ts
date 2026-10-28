import type { Flavour } from "@projected/architecture";
import { camel, pascal, plural, wordsOf } from "./names.js";

/**
 * Versions of what a new service depends on besides the framework — the ones the framework is
 * built and tested with (a test holds them to the workspace's own).
 */
export const DEPENDENCY_VERSIONS = {
  "@opentelemetry/api": "^1.10.0",
  "better-auth": "^1.7.14",
  pg: "^8.23.1",
  "@types/pg": "^8.23.1",
  "@types/node": "^22.19.0",
  "@stryker-mutator/core": "10.0.0",
  typescript: "6.0.3",
  vitest: "^5.0.5",
} as const;

const FRAMEWORK = ["application", "auth-better-auth", "domain", "http", "opentelemetry", "runtime", "store-memory", "store-postgres"];
const FRAMEWORK_DEV = ["architecture", "cli", "testing"];

export interface ServiceTemplate {
  readonly name: string;
  readonly flavour: Flavour;
  /** The version range of the `@projected/*` packages: `workspace:*` inside the framework's own workspace. */
  readonly framework: string;
}

const store = (flavour: Flavour) =>
  flavour === "event-sourced"
    ? { name: "eventStore", type: "EventStore", memory: "inMemoryEventStore", doc: "" }
    : { name: "stateStore", type: "StateStore", memory: "inMemoryStateStore", doc: "  /** Holds each aggregate's state, and the outbox of events its changes emit. */\n" };

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Every file of a new service, by path. The first aggregate comes from {@link aggregateFiles}. */
export function serviceFiles(service: ServiceTemplate): Record<string, string> {
  const { name, flavour } = service;
  const Name = pascal(name);
  const s = store(flavour);
  const dependencies = (names: readonly string[], extra: readonly (keyof typeof DEPENDENCY_VERSIONS)[]) =>
    Object.fromEntries(
      [...names.map((pkg) => [`@projected/${pkg}`, service.framework]), ...extra.map((pkg) => [pkg, DEPENDENCY_VERSIONS[pkg]])].sort(([a], [b]) =>
        a! < b! ? -1 : 1,
      ),
    );

  return {
    "package.json": json({
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        build: "tsc -b",
        start: "node .tsbuild/infrastructure/config/main.js",
        test: "vitest run",
        check: "tsc -b && vitest run && projected check",
        openapi: "projected openapi",
        lock: "projected contracts --update",
        // Not "docs": `pnpm docs` is pnpm's own command, and would never reach the script.
        catalog: "projected docs",
        mutate: "projected mutate",
      },
      dependencies: dependencies(FRAMEWORK, ["@opentelemetry/api", "better-auth", "pg"]),
      devDependencies: dependencies(FRAMEWORK_DEV, ["@stryker-mutator/core", "@types/node", "@types/pg", "typescript", "vitest"]),
    }),
    "projected.json": json({
      flavour,
      securitySchemes: {
        betterAuthSession: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
          description: "Session cookie set by better-auth's sign-in endpoints.",
        },
        bearer: { type: "http", scheme: "bearer", description: "Session token from better-auth's bearer plugin." },
      },
    }),
    "tsconfig.json": json({ files: [], references: [{ path: "src/infrastructure" }, { path: "test" }] }),
    "src/domain/tsconfig.json": json({
      extends: "@projected/architecture/tsconfig/domain.json",
      compilerOptions: { rootDir: ".", outDir: "../../.tsbuild/domain" },
      include: ["**/*.ts"],
    }),
    "src/application/tsconfig.json": json({
      extends: "@projected/architecture/tsconfig/application.json",
      compilerOptions: { rootDir: ".", outDir: "../../.tsbuild/application" },
      include: ["**/*.ts"],
      references: [{ path: "../domain" }],
    }),
    "src/infrastructure/tsconfig.json": json({
      extends: "@projected/architecture/tsconfig/infrastructure.json",
      compilerOptions: { rootDir: ".", outDir: "../../.tsbuild/infrastructure" },
      include: ["**/*.ts"],
      references: [{ path: "../domain" }, { path: "../application" }],
    }),
    "test/tsconfig.json": json({
      extends: "@projected/architecture/tsconfig/test.json",
      compilerOptions: { rootDir: ".", outDir: "../.tsbuild/test" },
      include: ["**/*.ts"],
      references: [{ path: "../src/domain" }, { path: "../src/application" }, { path: "../src/infrastructure" }],
    }),
    ".gitignore": ["node_modules/", ".tsbuild/", ".vitest-cache/", ".stryker-tmp/", "reports/", ""].join("\n"),
    "eslint.config.js": `// Editor integration only: \`projected check\` runs the same rules itself and ignores this file.
import { projectedEslint } from "@projected/architecture/eslint";

export default projectedEslint();
`,
    "vitest.config.ts": `import { defineConfig } from "vitest/config";

// The cache stays in the project: mutation sandboxes share node_modules, and must not share a cache.
export default defineConfig({ cacheDir: ".vitest-cache", test: { include: ["test/**/*.test.ts"] } });
`,
    "README.md": `# ${name}

A [projected](https://github.com/martinzokov/projected) service, ${flavour}. What it offers, stores
and announces is in [\`docs/catalog.md\`](docs/catalog.md), generated from the code by \`projected docs\`.

\`\`\`sh
pnpm install
pnpm check      # compile, test, and \`projected check\` (boundaries, rules, contract lock, generated files)
pnpm build && pnpm start   # in memory; DATABASE_URL=postgres://… for PostgreSQL
\`\`\`

Grow it with the generators, then fill in the business rules they leave as stubs:

\`\`\`sh
projected new aggregate <name>
projected new command <type> --aggregate <name> --event <EventType>
projected new query <type> --aggregate <name>        # or --port <Port>
projected new port <Name> --operations <a,b>
projected new event-handler <name> --on <Event,…>    # optionally --port <Port>
\`\`\`
`,
    "src/application/port/driving/index.ts": `import { defineContracts } from "@projected/application/${flavour}";

/**
 * Everything ${name} offers. HTTP endpoints, the OpenAPI document, typed clients and the
 * contract lock are all derived from this list.
 */
export const ${camel(name)}Contracts = defineContracts({
  name: "${name}",
  // Signed-in callers only, by default. An operation can require permissions, or be public.
  access: "authenticated",
  commands: [],
  queries: [],
});
`,
    [`src/infrastructure/config/${name}.ts`]: `import {
  createApplication,
  type CheckpointStore,
  type Clock,
  type DocumentStore,
  type EventHandler,
  type IdGenerator,
  type IdempotencyStore,
  type ReadinessCheck,
  type ${s.type},
  type Telemetry,
} from "@projected/application/${flavour}";
import { ${camel(name)}Contracts } from "../../application/port/driving/index.js";

/** Everything ${name} needs from the outside world. Swap any of it without touching a use case. */
export interface ${Name}Infrastructure {
${s.doc}  readonly ${s.name}: ${s.type};
  readonly checkpoints: CheckpointStore;
  /** Holds read models. */
  readonly documents: DocumentStore;
  /** Remembers command outcomes so retried commands never run twice. */
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly telemetry?: Telemetry;
  /** Further event handlers, e.g. a relay publishing events to a broker. */
  readonly eventHandlers?: readonly EventHandler[];
  /** What the service cannot serve without, reported by \`GET /health/ready\`. */
  readonly readiness?: readonly ReadinessCheck[];
  readonly onDefect?: (defect: Error) => void;
}

/**
 * The composition root: binds every contract to its handler. Leaving a contract out, or binding
 * a handler to the wrong contract, does not compile.
 */
export function compose${Name}(infrastructure: ${Name}Infrastructure) {
  const { ${s.name}, checkpoints, idempotency, ids, telemetry } = infrastructure;
  return createApplication(${camel(name)}Contracts, {
    ids,
    commands: {},
    queries: {},
    eventHandling: {
      handlers: [...(infrastructure.eventHandlers ?? [])],
      store: ${s.name},
      checkpoints,
    },
    idempotency: { store: idempotency },
    readiness: infrastructure.readiness ?? [],
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(infrastructure.onDefect === undefined ? {} : { onDefect: infrastructure.onDefect }),
  });
}
`,
    "src/infrastructure/config/environment.ts": `import { inMemoryCheckpointStore, inMemoryDocumentStore, inMemoryIdempotencyStore, ${s.memory} } from "@projected/store-memory/${flavour}";
import { fromPool, migrate, postgresReadiness, postgresStores } from "@projected/store-postgres/${flavour}";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getMigrations } from "better-auth/db/migration";
import { admin, bearer } from "better-auth/plugins";
import pg from "pg";
import type { Clock } from "@projected/application/${flavour}";

/**
 * Picks real infrastructure from the environment, and in-memory stand-ins otherwise, so the
 * service runs with \`pnpm start\` alone and against PostgreSQL when configured:
 *
 *   DATABASE_URL   PostgreSQL for ${flavour === "event-sourced" ? "events" : "state and its outbox"}, checkpoints, idempotency, read models and better-auth
 *   AUTH_SECRET    better-auth's secret (required outside development)
 */
export async function environment(clock: Clock, env: NodeJS.ProcessEnv = process.env) {
  const pool = env.DATABASE_URL === undefined ? undefined : new pg.Pool({ connectionString: env.DATABASE_URL });
  const stores = await (async () => {
    if (pool === undefined) {
      return {
        ${s.name}: ${s.memory}({ clock }),
        checkpoints: inMemoryCheckpointStore(),
        idempotency: inMemoryIdempotencyStore({ clock }),
        documents: inMemoryDocumentStore(),
      };
    }
    const sql = fromPool(pool);
    await migrate(sql);
    return postgresStores(sql);
  })();

  const authOptions = {
    baseURL: env.PUBLIC_URL ?? \`http://localhost:\${env.PORT ?? 3000}\`,
    secret: env.AUTH_SECRET ?? "development-only-secret-change-me-0000000000",
    database: pool ?? memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
    plugins: [bearer(), admin()],
  };
  // better-auth checks its tables when it is created, so they must exist first.
  if (pool !== undefined) await (await getMigrations(authOptions)).runMigrations();
  const auth = betterAuth(authOptions);

  return {
    ...stores,
    auth,
    // Not ready while the database is unreachable.
    readiness: pool === undefined ? [] : [postgresReadiness(fromPool(pool))],
    close: async () => {
      await pool?.end();
    },
  };
}
`,
    "src/infrastructure/config/main.ts": `import { OPERATE } from "@projected/application/${flavour}";
import { betterAuthAuthenticator, betterAuthRoutes, betterAuthSecuritySchemes, rolesOf } from "@projected/auth-better-auth";
import { httpHandler } from "@projected/http";
import { serve } from "@projected/http/node";
import { openTelemetry } from "@projected/opentelemetry";
import { monitorBacklog, randomIds, shutdownGracefully, systemClock } from "@projected/runtime";
import { environment } from "./environment.js";
import { compose${Name} } from "./${name}.js";

const clock = systemClock();
const infrastructure = await environment(clock);
// Spans go wherever the OpenTelemetry SDK sends them; register one (e.g. @opentelemetry/sdk-node) to export.
const telemetry = openTelemetry();

const app = compose${Name}({ ...infrastructure, clock, ids: randomIds(), telemetry, onDefect: (defect) => console.error("defect", defect) });

// Signed-in users hold the permissions returned here. Admins operate the service (\`projected operate\`);
// add the permissions your operations require.
const authenticator = betterAuthAuthenticator(infrastructure.auth, {
  permissions: (session) => (rolesOf(session).includes("admin") ? [OPERATE] : []),
});

const server = await serve(
  httpHandler(app, {
    authenticator,
    routes: betterAuthRoutes(infrastructure.auth),
    openApi: { version: "0.1.0", securitySchemes: betterAuthSecuritySchemes() },
  }),
  { port: Number(process.env.PORT ?? 3000) },
);
console.log(\`${name} is listening on \${server.url} — OpenAPI document at \${server.url}/openapi.json\`);

// Event handler lag, as the projected.event_handler.lag gauge: alert when it keeps growing.
const backlog = monitorBacklog(app, { clock, onError: (error) => console.error("backlog", error.message) });

// On SIGTERM: report draining, give load balancers SHUTDOWN_GRACE_MS to notice, stop taking
// requests, finish those in flight, then close connections.
shutdownGracefully({
  app,
  intake: [server, backlog],
  close: infrastructure.close,
  graceMs: Number(process.env.SHUTDOWN_GRACE_MS ?? 0),
  log: (message) => console.log(message),
});
`,
    [`test/${name}.ts`]: `import { httpHandler } from "@projected/http";
import { inMemoryCheckpointStore, inMemoryDocumentStore, inMemoryIdempotencyStore, ${s.memory} } from "@projected/store-memory/${flavour}";
import { fixedClock, principal, sequentialIds, tokenAuthenticator } from "@projected/testing/${flavour}";
import { compose${Name} } from "../src/infrastructure/config/${name}.js";

/** A signed-in caller. Give it the permissions your operations require: \`principal("u-member", ["invoices:manage"])\`. */
export const member = principal("u-member");

/** The real composition, with deterministic time and ids and in-memory stores, served by the real HTTP handler. */
export function test${Name}() {
  const clock = fixedClock("2024-01-01T09:00:00.000Z");
  const defects: Error[] = [];
  const app = compose${Name}({
    ${s.name}: ${s.memory}({ clock, ids: sequentialIds("event") }),
    checkpoints: inMemoryCheckpointStore(),
    documents: inMemoryDocumentStore(),
    idempotency: inMemoryIdempotencyStore({ clock }),
    clock,
    ids: sequentialIds("id"),
    onDefect: (defect) => defects.push(defect),
  });
  const handler = httpHandler(app, {
    messageIds: sequentialIds("request").next,
    authenticator: tokenAuthenticator({ "member-token": member }),
  });
  /** POST as the member unless other headers are given. */
  const post = async (path: string, body: unknown, headers: Record<string, string> = { authorization: "Bearer member-token" }) => {
    const response = await handler(
      new Request(\`http://${name}.test\${path}\`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { app, handler, post, clock, defects };
}
`,
    "test/http.test.ts": `import { describe, expect, it } from "vitest";
import { test${Name} } from "./${name}.js";

describe("${name} over HTTP", () => {
  it("serves its OpenAPI document", async () => {
    const { handler } = test${Name}();

    const response = await handler(new Request("http://${name}.test/openapi.json"));

    expect(response.status).toBe(200);
  });
});
`,
    "test/architecture.test.ts": `import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Mutation testing runs the tests against instrumented copies of src/, which are not the code this
// test is about: it checks the code you wrote, and \`projected check\` runs it on that in CI. The
// checker is imported in the test, since a skipped file still loads what it imports.
describe.skipIf(process.env["PROJECTED_MUTATION"] !== undefined)("architecture", () => {
  it("keeps every boundary", async () => {
    const { checkArchitecture, formatViolations } = await import("@projected/architecture");
    const report = await checkArchitecture(fileURLToPath(new URL("..", import.meta.url)), { flavour: "${flavour}" });

    expect(formatViolations(report.violations)).toBe("");
    // Type-checked rules build a TypeScript program for the adapters: seconds, not milliseconds.
  }, 60_000);
});
`,
  };
}

export interface AggregateTemplate {
  readonly flavour: Flavour;
  /** camelCase, as the aggregate is named in `defineAggregate`. */
  readonly name: string;
}

const capitalised = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;

/** Text of the aggregate's words: lineItem → "line item". */
export const phrase = (name: string) => wordsOf(name).join(" ");

/** The aggregate module and its first test — the property every aggregate of the flavour must have. */
export function aggregateFiles({ flavour, name }: AggregateTemplate, dir: string): Record<string, string> {
  const Name = pascal(name);
  const words = phrase(name);
  const domain =
    flavour === "event-sourced"
      ? `import { defineAggregate } from "@projected/domain/event-sourced";

/** What decisions about one ${words} need to know, folded from its events by \`evolve\`. */
export type ${Name}State = { readonly status: "unknown" };

export const ${Name} = defineAggregate({
  name: "${name}",
  initialState: (): ${Name}State => ({ status: "unknown" }),
  events: [],
  evolve: {},
});

/**
 * Decisions: pure functions from the current state and a request to the events that follow,
 * or the business rule that refuses them. No I/O, no clock, no randomness — anything like that
 * arrives as input.
 */
`
      : `import { defineAggregate, z, type StateOf } from "@projected/domain/state-based";

/**
 * ${capitalised(plural(words))}, each stored as its current state: the schema holds what decisions about
 * one need to know. Its events are what other parts of the system hear about.
 */
export const ${Name} = defineAggregate({
  name: "${name}",
  schema: z.object({}),
  events: [],
});

/** The state of one ${words}. \`undefined\` stands for "no such ${words}". */
export type ${Name}State = StateOf<typeof ${Name}>;

/**
 * Decisions: pure functions from the current state and a request to the next state and the
 * events announcing it, or the business rule that refuses them. No I/O, no clock, no randomness
 * — anything like that arrives as input.
 */
`;
  const property =
    flavour === "event-sourced"
      ? `  it("folds any history of ${words} events, however unlikely its order", () => {\n    everyHistoryFolds(${Name});\n  });`
      : `  it("stores every valid ${words} state unchanged", () => {\n    everyStateRoundTrips(${Name});\n  });`;
  return {
    [`src/domain/${dir}/${dir}.ts`]: domain,
    [`test/domain/${dir}.test.ts`]: `import { describe, it } from "vitest";
import { ${flavour === "event-sourced" ? "everyHistoryFolds" : "everyStateRoundTrips"} } from "@projected/testing/${flavour}";
import { ${Name} } from "../../src/domain/${dir}/${dir}.js";

describe("${words}", () => {
${property}
});
`,
  };
}

export const eventsModule = (flavour: Flavour, aggregate: string) => `import { defineEvent, z } from "@projected/domain/${flavour}";

/** Facts about ${plural(phrase(aggregate))}, in the past tense. Persisted forever: never change a published schema. */
`;

export const eventDefinition = (type: string, idField: string) => `export const ${type} = defineEvent("${type}", {
  schema: z.object({ ${idField}: z.string() }),
});`;

/** The stub decision a new command calls: it records the event, and the business rules are yours to write. */
export function decisionFunction(flavour: Flavour, decision: string, aggregate: string, event: string, idField: string): string {
  const Name = pascal(aggregate);
  return flavour === "event-sourced"
    ? `export function ${decision}(state: ${Name}State, input: { ${idField}: string }): Decision<typeof ${Name}> {
  return Result.ok([${event}(input)]);
}`
    : `export function ${decision}(state: ${Name}State | undefined, input: { ${idField}: string }): Decision<typeof ${Name}> {
  return Result.ok(changeTo({ ...state }, ${event}(input)));
}`;
}

export function decisionTest(flavour: Flavour, decision: string, aggregate: string, event: string, idField: string): string {
  const Name = pascal(aggregate);
  const input = `{ ${idField}: "${aggregate}-1" }`;
  const then = flavour === "event-sourced" ? `.thenEvents(${event}(${input}))` : `.thenChangesTo({}, ${event}(${input}))`;
  return `it("${decision} records ${event}", () => {
  given(${Name})
    .when((state) => ${decision}(state, ${input}))
    ${then};
});`;
}

export interface OperationTemplate {
  readonly flavour: Flavour;
  readonly kind: "command" | "query";
  readonly type: string;
  /** The aggregate's id field, when the operation addresses one aggregate. */
  readonly idField?: string;
}

export function contractModule({ flavour, kind, type, idField }: OperationTemplate, summary: string): string {
  const define = kind === "command" ? "defineCommand" : "defineQuery";
  return `import { ${define}, z } from "@projected/application/${flavour}";

export const ${pascal(type)} = ${define}({
  type: "${type}",
  summary: "${summary}",
  input: z.object({${idField === undefined ? "" : ` ${idField}: z.string() `}}),
  output: z.object({}),
});
`;
}

export interface UseCaseTemplate {
  readonly flavour: Flavour;
  readonly type: string;
  readonly aggregate?: { readonly name: string; readonly module: string; readonly repository: string; readonly idField: string };
  readonly port?: { readonly name: string; readonly module: string; readonly variable: string };
}

export function commandUseCase({ flavour, type, aggregate }: UseCaseTemplate & { aggregate: NonNullable<UseCaseTemplate["aggregate"]> }, decision: string): string {
  const Name = pascal(aggregate.name);
  return `import type { AggregateRepository, CommandHandler } from "@projected/application/${flavour}";
import { ${Name}, ${decision} } from "${aggregate.module}";
import type { ${pascal(type)} } from "../port/driving/${type}.js";

export const ${camel(type)} =
  (deps: { ${aggregate.repository}: AggregateRepository<typeof ${Name}> }): CommandHandler<typeof ${pascal(type)}> =>
  async (input, context) =>
    (await deps.${aggregate.repository}.execute(input.${aggregate.idField}, (state) => ${decision}(state, input), context)).map(() => ({}));
`;
}

export function queryUseCase({ flavour, type, aggregate, port }: UseCaseTemplate): string {
  if (aggregate !== undefined) {
    const Name = pascal(aggregate.name);
    return `import type { AggregateRepository, QueryHandler } from "@projected/application/${flavour}";
import type { ${Name} } from "${aggregate.module}";
import type { ${pascal(type)} } from "../port/driving/${type}.js";

/** Answers from the aggregate itself: always consistent with the last command. */
export const ${camel(type)} =
  (deps: { ${aggregate.repository}: AggregateRepository<typeof ${Name}> }): QueryHandler<typeof ${pascal(type)}> =>
  async (input) =>
    (await deps.${aggregate.repository}.load(input.${aggregate.idField})).map(() => ({}));
`;
  }
  return `import { Result, type QueryHandler } from "@projected/application/${flavour}";
${port === undefined ? "" : `import type { ${port.name} } from "${port.module}";\n`}import type { ${pascal(type)} } from "../port/driving/${type}.js";

export const ${camel(type)} =
  (${port === undefined ? "" : `deps: { ${port.variable}: ${port.name} }`}): QueryHandler<typeof ${pascal(type)}> =>
  async () =>
    Result.ok({});
`;
}

export function portModule(flavour: Flavour, name: string, operations: readonly string[]): string {
  return `import type { DependencyFailure, DependencyUnavailable, Result } from "@projected/application/${flavour}";

type DependencyError = DependencyUnavailable | DependencyFailure;

/** ${capitalised(phrase(name))}: named for what the application needs, not for what provides it. */
export interface ${name} {
${operations.map((operation) => `  ${operation}(): Promise<Result<void, DependencyError>>;`).join("\n")}
}
`;
}

export function adapterModule(flavour: Flavour, port: string, portModulePath: string, factory: string, operations: readonly string[]): string {
  const onDocuments = factory.startsWith("document");
  return `import { Result${onDocuments ? ", type DocumentStore" : ""} } from "@projected/application/${flavour}";
import type { ${port} } from "${portModulePath}";

/**
${
  onDocuments
    ? ` * The {@link ${port}} on any {@link DocumentStore} — in memory for tests, PostgreSQL in production,
 * without changing this adapter. \`documents.collection(name, schema)\` is a typed collection to keep it in.`
    : ` * The {@link ${port}}. Wrap calls that throw in \`fromDependency\`, so failures come back as Results.`
}
 */
export function ${factory}(${onDocuments ? "documents: DocumentStore" : ""}): ${port} {
  return {
${operations.map((operation) => `    ${operation}: async () => Result.ok(undefined),`).join("\n")}
  };
}
`;
}

export interface EventHandlerTemplate {
  readonly flavour: Flavour;
  readonly name: string;
  readonly events: ReadonlyArray<{ readonly type: string; readonly module: string }>;
  readonly port?: { readonly name: string; readonly module: string; readonly variable: string };
}

export function eventHandlerModule({ flavour, name, events, port }: EventHandlerTemplate): string {
  const byModule = new Map<string, string[]>();
  for (const event of events) byModule.set(event.module, [...(byModule.get(event.module) ?? []), event.type]);
  const imports = [...byModule].map(([module, types]) => `import { ${[...types].sort().join(", ")} } from "${module}";`);
  if (port !== undefined) imports.push(`import type { ${port.name} } from "${port.module}";`);
  return `import { Result, defineEventHandler } from "@projected/application/${flavour}";
${imports.join("\n")}

/** Reacts to ${events.map((e) => e.type).join(", ")}. Runs at least once per event: keep it idempotent, safe to replay. */
export const ${camel(name)} = (${port === undefined ? "" : `deps: { ${port.variable}: ${port.name} }`}) =>
  defineEventHandler({
    name: "${name}",
    events: [${events.map((e) => e.type).join(", ")}],
    handle: {
${events.map((e) => `      ${e.type}: () => Result.ok(undefined),`).join("\n")}
    },
  });
`;
}

export function httpTest(kind: "command" | "query", type: string, service: string, input: string): string {
  return `it("serves ${type}", async () => {
  const { post } = test${pascal(service)}();

  const response = await post("/${kind === "command" ? "commands" : "queries"}/${type}/version/1", ${input});

  expect(response).toEqual({ status: 200, body: { status: "ok", value: {} } });
});`;
}
