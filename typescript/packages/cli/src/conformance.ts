import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { CommandResult } from "./commands.js";

interface Step {
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly as?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly raw?: string;
  };
  readonly expect: {
    readonly status: number | readonly number[];
    readonly headers?: Readonly<Record<string, string>>;
    readonly schema?: string;
    readonly body?: unknown;
  };
}

interface Suite {
  readonly suite: string;
  readonly description: string;
  readonly principals?: Readonly<Record<string, { readonly permissions: readonly string[] }>>;
  readonly scenarios: ReadonlyArray<{ readonly name: string; readonly spec?: string; readonly steps: readonly Step[] }>;
}

export interface ConformanceOptions {
  /** The running service's base URL. */
  readonly url: string;
  /** Suite names (`protocol`, `school`) or paths to suite files. Defaults to `protocol`. */
  readonly suites?: readonly string[];
  /** Bearer tokens by principal name. Defaults to `<name>-token`. */
  readonly tokens?: Readonly<Record<string, string>>;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** The language-neutral spec directory: found from this module's location, like the skills. */
function specDir(): string | undefined {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, "spec", "conformance", "scenario.schema.json"))) return join(dir, "spec");
  }
  return undefined;
}

type Vars = Map<string, unknown>;

/** `${name}` replaced in a string — by the value itself when the string is nothing else. */
function interpolate(text: string, vars: Vars): unknown {
  const whole = /^\$\{([a-zA-Z0-9_]+)\}$/.exec(text);
  if (whole !== null && vars.has(whole[1]!)) return vars.get(whole[1]!);
  return text.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (placeholder, name: string) => (vars.has(name) ? String(vars.get(name)) : placeholder));
}

function substitute(value: unknown, vars: Vars): unknown {
  if (typeof value === "string") return interpolate(value, vars);
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, vars)]));
  return value;
}

const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value)?.slice(0, 120));

/** Match `actual` against `expected` (see spec/conformance/README.md), collecting what differs. */
function match(expected: unknown, actual: unknown, path: string, vars: Vars, problems: string[]): void {
  if (typeof expected === "string") {
    const typed: Record<string, string> = { $string: "string", $number: "number", $boolean: "boolean" };
    if (expected === "$any") {
      if (actual === undefined) problems.push(`${path}: missing`);
    } else if (typed[expected] !== undefined) {
      if (typeof actual !== typed[expected]) problems.push(`${path}: ${show(actual)}, expected a ${typed[expected]}`);
    } else if (expected.startsWith("$capture:")) {
      if (actual === undefined) problems.push(`${path}: missing`);
      else vars.set(expected.slice("$capture:".length), actual);
    } else {
      const wanted = interpolate(expected, vars);
      if (actual !== wanted) problems.push(`${path}: ${show(actual)}, expected ${show(wanted)}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      problems.push(`${path}: ${show(actual)}, expected ${expected.length} item${expected.length === 1 ? "" : "s"}`);
      return;
    }
    expected.forEach((item, index) => match(item, actual[index], `${path}[${index}]`, vars, problems));
    return;
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
      problems.push(`${path}: ${show(actual)}, expected an object`);
      return;
    }
    for (const [key, item] of Object.entries(expected)) match(item, (actual as Record<string, unknown>)[key], `${path}.${key}`, vars, problems);
    return;
  }
  if (actual !== expected) problems.push(`${path}: ${show(actual)}, expected ${show(expected)}`);
}

/** A header matches its value, ignoring parameters (`; charset=utf-8`) the scenario does not list. */
function headerMatches(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  if (expected === "$present") return true;
  return actual === expected || (!expected.includes(";") && actual.split(";")[0]?.trim() === expected);
}

/**
 * `projected conformance --url <service> [--suite <name|file>]...`: run the language-neutral
 * scenarios in `spec/conformance/` against a running service, over HTTP only — so it judges a
 * service in any language. `protocol` holds any projected service; `school` an implementation of
 * the reference service.
 */
export async function conformance(options: ConformanceOptions): Promise<CommandResult> {
  const spec = specDir();
  if (spec === undefined) return { ok: false, lines: ["conformance: cannot find spec/conformance next to @projected/cli"] };
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats.default(ajv);
  ajv.addSchema(JSON.parse(readFileSync(join(spec, "wire.schema.json"), "utf8")) as object);
  const validSuite = ajv.compile(JSON.parse(readFileSync(join(spec, "conformance", "scenario.schema.json"), "utf8")) as object);

  const suites: Suite[] = [];
  for (const name of options.suites ?? ["protocol"]) {
    const named = join(spec, "conformance", `${name}.json`);
    const path = existsSync(named) ? named : resolve(name);
    if (!existsSync(path)) return { ok: false, lines: [`conformance: no suite ${name} — the built-in ones are protocol and school, or give a file`] };
    const suite = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!validSuite(suite)) return { ok: false, lines: [`conformance: ${path} is not a valid suite: ${ajv.errorsText(validSuite.errors)}`] };
    suites.push(suite as Suite);
  }

  const send = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, "");
  const run = randomBytes(4).toString("hex");
  const firstDay = Date.UTC(2200, 0, 1) + randomBytes(2).readUInt16BE() * 7 * 86_400_000;
  const lines: string[] = [];
  let passed = 0;
  let total = 0;
  let scenarioIndex = 0;

  for (const suite of suites) {
    const results: string[] = [];
    let suitePassed = 0;
    for (const scenario of suite.scenarios) {
      const index = scenarioIndex++;
      const vars: Vars = new Map<string, unknown>([
        ["id", `${run}-${index}`],
        ["date", new Date(firstDay + index * 86_400_000).toISOString().slice(0, 10)],
      ]);
      let failure: string | undefined;
      for (const [position, step] of scenario.steps.entries()) {
        const { request, expect } = step;
        const headers: Record<string, string> = Object.fromEntries(
          Object.entries(request.headers ?? {}).map(([name, value]) => [name, String(interpolate(value, vars))]),
        );
        if (request.as !== undefined) headers["authorization"] = `Bearer ${options.tokens?.[request.as] ?? `${request.as}-token`}`;
        let body: string | undefined;
        if (request.raw !== undefined) body = String(interpolate(request.raw, vars));
        else if (request.body !== undefined) {
          body = JSON.stringify(substitute(request.body, vars));
          headers["content-type"] ??= "application/json";
        }
        let response: Response;
        try {
          response = await send(`${base}${String(interpolate(request.path, vars))}`, { method: request.method, headers, ...(body === undefined ? {} : { body }) });
        } catch (error) {
          failure = `step ${position + 1}: cannot reach ${base}: ${(error as Error).message}`;
          break;
        }
        const text = await response.text();
        let parsed: unknown = text;
        try {
          parsed = text === "" ? undefined : JSON.parse(text);
        } catch {
          // Not JSON: matched as text.
        }
        const problems: string[] = [];
        const statuses = typeof expect.status === "number" ? [expect.status] : expect.status;
        if (!statuses.includes(response.status)) problems.push(`status ${response.status}, expected ${statuses.join(" or ")}`);
        for (const [name, value] of Object.entries(expect.headers ?? {})) {
          const wanted = value === "$present" ? value : String(interpolate(value, vars));
          if (!headerMatches(wanted, response.headers.get(name))) problems.push(`header ${name}: ${show(response.headers.get(name) ?? undefined)}, expected ${show(wanted)}`);
        }
        if (expect.schema !== undefined) {
          const validate = ajv.getSchema(`urn:projected:spec:wire:1#/$defs/${expect.schema}`);
          if (validate === undefined) problems.push(`no definition ${expect.schema} in wire.schema.json`);
          else if (!validate(parsed)) problems.push(`not a ${expect.schema}: ${ajv.errorsText(validate.errors)}`);
        }
        if (expect.body !== undefined) match(expect.body, parsed, "body", vars, problems);
        if (problems.length > 0) {
          failure = [`step ${position + 1} (${request.method} ${String(interpolate(request.path, vars))}): ${problems[0]}`, ...problems.slice(1).map((p) => `    ${p}`)].join("\n");
          break;
        }
      }
      total++;
      if (failure === undefined) {
        passed++;
        suitePassed++;
        results.push(`  ✓ ${scenario.name}`);
      } else {
        results.push(`  ✗ ${scenario.name}${scenario.spec === undefined ? "" : ` (${scenario.spec})`} — ${failure}`);
      }
    }
    lines.push(`conformance: ${suite.suite} — ${suitePassed}/${suite.scenarios.length} scenarios`, ...results);
  }
  lines.push(`conformance: ${passed}/${total} scenarios pass against ${base}`);
  return { ok: passed === total, lines };
}
