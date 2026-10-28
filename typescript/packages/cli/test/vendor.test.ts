import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { DependencyFailure } from "@projected/application";
import { HttpStatusError, httpClient } from "@projected/http";
import {
  canonicalSpec,
  compareSpecs,
  generateClient,
  loadProject,
  parseSpec,
  specHash,
  vendorAdd,
  vendorCheck,
  vendorGenerate,
  vendorUpdate,
} from "@projected/cli";

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, "..", "..");
const scratch = join(here, "..", ".tsbuild", "vendor");
const spec = (version: string) => join(here, "fixtures", `weather-${version}.yaml`);
const documentOf = (version: string) => parseSpec(readFileSync(spec(version), "utf8"), spec(version));
let counter = 0;
const roots: string[] = [];

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function generated(version = "v1"): string {
  const document = documentOf(version);
  return generateClient({ name: "weather", document, specPath: "vendor/weather.openapi.json", specHash: specHash(canonicalSpec(document)) });
}

/** A scratch directory that resolves @projected/* to the workspace packages. */
function scratchProject(files: Record<string, string>): string {
  const root = join(scratch, `${process.pid}-${++counter}`);
  mkdirSync(join(root, "node_modules", "@projected"), { recursive: true });
  for (const name of ["application", "domain", "http"]) symlinkSync(join(packages, name), join(root, "node_modules", "@projected", name), "dir");
  for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
  return root;
}

describe("generated clients", () => {
  it("are deterministic, and do not depend on how the spec was formatted", () => {
    const fromYaml = generated();
    const fromPinned = generateClient({
      name: "weather",
      document: parseSpec(canonicalSpec(documentOf("v1")), "pinned.json"),
      specPath: "vendor/weather.openapi.json",
      specHash: specHash(canonicalSpec(documentOf("v1"))),
    });

    expect(fromPinned).toBe(fromYaml);
  });

  it("define components before they are used, and recursive ones lazily", () => {
    const code = generated();

    expect(code.indexOf("export const Day =")).toBeLessThan(code.indexOf("export const Forecast ="));
    expect(code).toContain(`"parent": z.lazy((): z.ZodType => Place).optional()`);
  });

  it("name methods by operationId, or by method and path when there is none", () => {
    const code = generated();

    expect(code).toMatch(/ getForecast: <[^>]*>\(input: GetForecastInput/);
    expect(code).toMatch(/ getLocation: <[^>]*>\(input: GetLocationInput/);
    expect(code).toMatch(/ deleteV1AlertsByAlertId: <[^>]*>\(input: DeleteV1AlertsByAlertIdInput/);
  });

  it("type-check under the strictest settings projected uses", async () => {
    const root = scratchProject({
      "weather-client.ts": generated(),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          noImplicitOverride: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2023",
          lib: ["ES2023", "DOM"],
          types: [],
          noEmit: true,
          skipLibCheck: true,
        },
        files: ["weather-client.ts"],
      }),
      "package.json": JSON.stringify({ type: "module" }),
    });
    const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");

    const outcome = await promisify(execFile)(process.execPath, [tsc, "-p", root]).then(
      () => "",
      (error: { stdout?: string }) => error.stdout ?? String(error),
    );

    expect(outcome).toBe("");
  }, 60_000);
});

describe("calling a vendor through its generated client", () => {
  async function client(respond: (request: Request) => Response) {
    const root = scratchProject({ "weather-client.ts": generated() });
    const module = (await import(pathToFileURL(join(root, "weather-client.ts")).href)) as {
      weatherClient: (http: ReturnType<typeof httpClient>) => Record<string, (input?: unknown, options?: unknown) => Promise<unknown>>;
    };
    const seen: Request[] = [];
    const http = httpClient({
      dependency: "weather",
      baseUrl: "https://api.weather.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seen.push(request);
        return respond(request);
      },
    });
    return { weather: module.weatherClient(http), seen };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends parameters where the spec puts them and returns the validated body", async () => {
    const forecast = { latitude: 1, longitude: 2, daily: [{ date: "2024-06-01", maxTempC: 21, conditions: "sunny" }], extra: "ignored" };
    const { weather, seen } = await client(() => json(forecast));

    const outcome = (await weather.getForecast?.({ latitude: 1, longitude: 2, daily: ["max", "rain"] })) as { unwrap(): { body: unknown } };

    expect(outcome.unwrap().body).toEqual({ latitude: 1, longitude: 2, daily: forecast.daily });
    expect(new URL(seen[0]?.url ?? "").searchParams.get("daily")).toBe("max,rain");
  });

  it("encodes path parameters and sends headers", async () => {
    const { weather, seen } = await client(() => json({ alertId: "a-1" }, 201));

    await weather.createAlert?.({ xApiKey: "secret", body: { locationId: "l 1", threshold: 30 } });
    await weather.getLocation?.({ locationId: "l 1" });

    expect(seen[0]?.headers.get("x-api-key")).toBe("secret");
    expect(seen[1]?.url).toBe("https://api.weather.test/v1/locations/l%201");
  });

  it("reports a response that breaks the spec as a dependency failure", async () => {
    const { weather } = await client(() => json({ latitude: "north" }));

    const outcome = (await weather.getForecast?.({ latitude: 1, longitude: 2 })) as { isErr(): boolean; error: unknown };

    expect(outcome.isErr() && DependencyFailure.is(outcome.error)).toBe(true);
  });

  it("returns statuses the adapter expects as HttpStatusError", async () => {
    const { weather } = await client(() => new Response("", { status: 404 }));

    const outcome = (await weather.getLocation?.({ locationId: "nowhere" }, { expectedErrors: [404] })) as { isErr(): boolean; error: unknown };

    expect(outcome.isErr() && HttpStatusError.is(outcome.error)).toBe(true);
  });
});

describe("comparing spec versions", () => {
  it("finds nothing breaking in additions", () => {
    const changes = compareSpecs(documentOf("v1"), documentOf("v1.1"));

    expect(changes.filter((change) => change.breaking)).toEqual([]);
    expect(changes.map((change) => `${change.operation}: ${change.description}`)).toEqual([
      'GET /v1/forecast: new optional query parameter "days"',
      "GET /v1/stations: added",
    ]);
  });

  it("finds removed operations, new requirements and responses the old schema would reject", () => {
    const breaking = compareSpecs(documentOf("v1"), documentOf("v2"))
      .filter((change) => change.breaking)
      .map((change) => `${change.operation}: ${change.description}`);

    expect(breaking).toEqual([
      "DELETE /v1/alerts/{alertId}: removed",
      'GET /v1/forecast: new required query parameter "model"',
      "GET /v1/forecast: response.daily[].maxTempC: no longer always present",
      'GET /v1/forecast: response.daily[].conditions: new values ["snow"] would be rejected',
    ]);
  });
});

describe("projected vendor", () => {
  function project(): string {
    const root = mkdtempSync(join(tmpdir(), "projected-vendor-"));
    roots.push(root);
    writeFileSync(join(root, "projected.json"), JSON.stringify({ flavour: "state-based" }));
    return root;
  }

  it("adds a vendor: pins the spec, generates the client, starts a port and adapter, records it", async () => {
    const root = project();

    const outcome = await vendorAdd(loadProject(root), "weather", spec("v1"));

    expect(outcome.ok).toBe(true);
    expect(loadProject(root).config.vendors?.["weather"]?.spec).toBe("vendor/weather.openapi.json");
    for (const file of [
      "vendor/weather.openapi.json",
      "src/infrastructure/adapter/driven/weather/weather-client.ts",
      "src/infrastructure/adapter/driven/weather/weather-adapter.ts",
      "src/application/port/driven/weather.ts",
    ]) {
      expect(() => readFileSync(join(root, file))).not.toThrow();
    }
    expect(vendorCheck(loadProject(root)).ok).toBe(true);
  });

  it("fails the check when the generated client was edited, until it is regenerated", async () => {
    const root = project();
    await vendorAdd(loadProject(root), "weather", spec("v1"));
    const client = join(root, "src/infrastructure/adapter/driven/weather/weather-client.ts");
    writeFileSync(client, `${readFileSync(client, "utf8")}// tweak\n`);

    const stale = vendorCheck(loadProject(root));
    vendorGenerate(loadProject(root), undefined);

    expect(stale.ok).toBe(false);
    expect(vendorCheck(loadProject(root)).ok).toBe(true);
  });

  it("refuses a breaking update and writes nothing, unless it is accepted", async () => {
    const root = project();
    await vendorAdd(loadProject(root), "weather", spec("v1"));
    const pinned = readFileSync(join(root, "vendor/weather.openapi.json"), "utf8");

    const refused = await vendorUpdate(loadProject(root), "weather", { source: spec("v2"), acceptBreaking: false });
    const unchanged = readFileSync(join(root, "vendor/weather.openapi.json"), "utf8");
    const accepted = await vendorUpdate(loadProject(root), "weather", { source: spec("v2"), acceptBreaking: true });

    expect(refused.ok).toBe(false);
    expect(refused.lines.join("\n")).toMatch(/BREAKING DELETE \/v1\/alerts\/\{alertId\}: removed/);
    expect(unchanged).toBe(pinned);
    expect(accepted.ok).toBe(true);
    expect(readFileSync(join(root, "vendor/weather.openapi.json"), "utf8")).not.toBe(pinned);
    expect(vendorCheck(loadProject(root)).ok).toBe(true);
  });

  it("never overwrites the port and adapter it started", async () => {
    const root = project();
    mkdirSync(join(root, "src/application/port/driven"), { recursive: true });
    writeFileSync(join(root, "src/application/port/driven/weather.ts"), "export interface Weather { mine: true }\n");

    await vendorAdd(loadProject(root), "weather", spec("v1"));

    expect(readFileSync(join(root, "src/application/port/driven/weather.ts"), "utf8")).toContain("mine: true");
  });
});
