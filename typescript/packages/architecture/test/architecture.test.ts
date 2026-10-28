import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkArchitecture, type Violation } from "@projected/architecture";

/**
 * Fitness tests for the enforcement itself. Each rule is proven by seeding a violation into a
 * clean fixture app and watching the check go red: a passing architecture check is worthless
 * until it has been seen to fail.
 */

// Every test runs dependency-cruiser and ESLint — some rules type-checked — on a real fixture:
// seconds each, and more when the machine is busy with other suites.
vi.setConfig({ testTimeout: 60_000 });

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, "..", "..");
const scratch = join(here, "..", ".tsbuild", "fixtures");
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
let counter = 0;

type Edit = Record<string, string | ((current: string) => string)>;

function fixture(edits: Edit = {}): string {
  const root = join(scratch, `app-${process.pid}-${++counter}`);
  rmSync(root, { recursive: true, force: true });
  cpSync(join(here, "fixture"), root, { recursive: true });
  mkdirSync(join(root, "node_modules", "@projected"), { recursive: true });
  for (const name of ["domain", "application", "architecture", "http", "testing"]) {
    symlinkSync(join(packages, name), join(root, "node_modules", "@projected", name), "dir");
  }
  for (const [file, edit] of Object.entries(edits)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof edit === "string" ? edit : edit(readFileSync(path, "utf8")));
  }
  return root;
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const rules = (violations: readonly Violation[]) => [...new Set(violations.map((v) => `${v.tool}/${v.rule}`))].sort();

describe("the clean fixture", () => {
  it("passes every check, having actually inspected its files", async () => {
    const report = await checkArchitecture(fixture());

    expect(report.violations).toEqual([]);
    expect(report.checked.dependencyCruiser).toBeGreaterThanOrEqual(6);
    expect(report.checked.eslint).toBeGreaterThanOrEqual(6);
  });
});

describe("checking only the files that changed", () => {
  it("finds the violations in the files it is given, and only those", async () => {
    const leak = `import { Increment } from "../application/port/driving/contracts.js";\nexport const x = Increment;\nexport const now = Date.now();\n`;
    const root = fixture({ "src/domain/leak.ts": leak });

    const elsewhere = await checkArchitecture(root, { files: ["src/domain/counter.ts"] });
    const changed = await checkArchitecture(root, { files: ["src/domain/leak.ts"] });
    const nothingToCheck = await checkArchitecture(root, { files: ["README.md"] });

    expect(rules(elsewhere.violations)).toEqual([]);
    expect(rules(changed.violations)).toEqual(["dependency-cruiser/domain-is-pure", "eslint/no-restricted-syntax"]);
    expect(nothingToCheck.violations).toEqual([]);
  });
});

describe("import boundaries (dependency-cruiser)", () => {
  const cases: Array<[string, Edit, string]> = [
    [
      "domain importing the application layer",
      { "src/domain/leak.ts": `import { Increment } from "../application/port/driving/contracts.js";\nexport const x = Increment;\n` },
      "dependency-cruiser/domain-is-pure",
    ],
    [
      "domain importing a node builtin",
      { "src/domain/leak.ts": `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n` },
      "dependency-cruiser/domain-is-pure",
    ],
    [
      "domain importing a framework adapter",
      { "src/domain/leak.ts": `import { httpHandler } from "@projected/http";\nexport const x = httpHandler;\n` },
      "dependency-cruiser/domain-is-pure",
    ],
    [
      "application importing infrastructure",
      {
        "src/application/usecase/leak.ts": `import { fixedLimits } from "../../infrastructure/adapter/driven/memory/fixed-limits.js";\nexport const x = fixedLimits;\n`,
      },
      "dependency-cruiser/application-not-infrastructure",
    ],
    [
      "application importing a framework adapter",
      { "src/application/usecase/leak.ts": `import { serve } from "@projected/http";\nexport const x = serve;\n` },
      "dependency-cruiser/application-only-uses-the-kernel",
    ],
    [
      "a port importing a use case",
      {
        "src/application/port/driven/leak.ts": `import { incrementCounter } from "../../usecase/increment.js";\nexport const x = incrementCounter;\n`,
      },
      "dependency-cruiser/ports-are-pure-interfaces",
    ],
    [
      "a driving adapter calling a use case directly",
      {
        "src/infrastructure/adapter/driving/web/controller.ts": `import { incrementCounter } from "../../../../application/usecase/increment.js";\nexport const x = incrementCounter;\n`,
      },
      "dependency-cruiser/driving-adapters-use-driving-ports",
    ],
    [
      "a driven adapter calling a use case",
      {
        "src/infrastructure/adapter/driven/memory/leak.ts": `import { incrementCounter } from "../../../../application/usecase/increment.js";\nexport const x = incrementCounter;\n`,
      },
      "dependency-cruiser/driven-adapters-implement-driven-ports",
    ],
    [
      "one adapter importing another",
      {
        "src/infrastructure/adapter/driven/other/leak.ts": `import { fixedLimits } from "../memory/fixed-limits.js";\nexport const x = fixedLimits;\n`,
      },
      "dependency-cruiser/adapters-are-independent",
    ],
    [
      "importing the composition root",
      {
        "src/infrastructure/adapter/driven/memory/leak.ts": `import { compose } from "../../../config/main.js";\nexport const x = compose;\n`,
      },
      "dependency-cruiser/nothing-imports-config",
    ],
    [
      "production code importing test helpers",
      { "src/infrastructure/config/leak.ts": `import { given } from "@projected/testing";\nexport const x = given;\n` },
      "dependency-cruiser/test-code-stays-in-tests",
    ],
    [
      "an import cycle",
      {
        "src/domain/a.ts": `import { b } from "./b.js";\nexport const a = (): number => b() + 1;\n`,
        "src/domain/b.ts": `import { a } from "./a.js";\nexport const b = (): number => a() - 1;\n`,
      },
      "dependency-cruiser/no-circular",
    ],
  ];

  it.each(cases)("rejects %s", async (_name, edits, expected) => {
    const report = await checkArchitecture(fixture(edits));

    expect(rules(report.violations)).toContain(expected);
  });
});

describe("one flavour per project (dependency-cruiser)", () => {
  it("accepts the fixture's own flavour", async () => {
    const report = await checkArchitecture(fixture(), { flavour: "event-sourced" });

    expect(report.violations).toEqual([]);
  });

  it("rejects the domain importing the other flavour's kernel", async () => {
    const report = await checkArchitecture(
      fixture({ "src/domain/leak.ts": `import { changeTo } from "@projected/domain/state-based";\nexport const x = changeTo;\n` }),
      { flavour: "event-sourced" },
    );

    expect(rules(report.violations)).toContain("dependency-cruiser/one-flavour");
  });

  it("lets tests build the app through the composition root", async () => {
    const report = await checkArchitecture(
      fixture({ "test/app.ts": `import { compose } from "../src/infrastructure/config/main.js";\nexport const app = compose;\n` }),
      { flavour: "event-sourced" },
    );

    expect(report.violations).toEqual([]);
  });

  it("rejects tests importing the other flavour", async () => {
    const report = await checkArchitecture(
      fixture({ "test/leak.ts": `import { aggregateRepository } from "@projected/application/event-sourced";\nexport const x = aggregateRepository;\n` }),
      { flavour: "state-based" },
    );

    expect(rules(report.violations)).toContain("dependency-cruiser/one-flavour");
  });
});

describe("Results at driven boundaries (ESLint)", () => {
  const legacy = `declare function legacyLookup(id: string): Promise<number>;\n`;

  it("rejects a driven port whose async operation does not return a Result", async () => {
    const report = await checkArchitecture(
      fixture({ "src/application/port/driven/lookup.ts": `export interface Lookup {\n  find(id: string): Promise<string>;\n}\n` }),
    );

    expect(rules(report.violations)).toContain("eslint/projected/driven-ports-return-results");
  });

  it("rejects a driven adapter awaiting a promise that can reject", async () => {
    const report = await checkArchitecture(
      fixture({
        "src/infrastructure/adapter/driven/memory/legacy.ts":
          legacy + `export const lookup = async (id: string): Promise<number> => {\n  const n = await legacyLookup(id);\n  return n;\n};\n`,
      }),
    );

    expect(rules(report.violations)).toContain("eslint/projected/driven-adapters-return-results");
  });

  it("accepts the same call inside fromDependency, and awaiting Results", async () => {
    const report = await checkArchitecture(
      fixture({
        "src/infrastructure/adapter/driven/memory/legacy.ts":
          `import { Result, fromDependency } from "@projected/application";\n` +
          legacy +
          `export const lookup = (id: string) => fromDependency("legacy", async () => (await legacyLookup(id)) * 2);\n` +
          `export const both = async (id: string) => {\n` +
          `  const [a, b] = await Promise.all([lookup(id), lookup(id)]);\n` +
          `  const c = await lookup(id);\n` +
          `  return Result.ok([a, b, c]);\n` +
          `};\n`,
      }),
    );

    expect(report.violations).toEqual([]);
  });
});

describe("design rules (ESLint, configurable)", () => {
  const crud = {
    "src/application/port/driving/crud.ts":
      `import { defineCommand, z } from "@projected/application";\n` +
      `export const CreateCounter = defineCommand({ type: "create-counter", input: z.object({}), output: z.object({}) });\n`,
  };
  const presentTense = {
    "src/domain/reset.ts": `import { defineEvent, z } from "@projected/domain/event-sourced";\nexport const CounterReset = defineEvent("CounterReset", { schema: z.object({}) });\nexport const CounterRewind = defineEvent("CounterRewind", { schema: z.object({}) });\n`,
  };
  const handler = (body: string) => ({
    "src/application/usecase/double.ts":
      `import { Result, type AggregateRepository, type CommandHandler } from "@projected/application/event-sourced";\n` +
      `import { Counter, increment } from "../../domain/counter.js";\n` +
      `import type { Increment } from "../port/driving/contracts.js";\n` +
      `export const incrementTwice =\n` +
      `  (deps: { counters: AggregateRepository<typeof Counter> }): CommandHandler<typeof Increment> =>\n` +
      `  async ({ counterId }, context) => {\n${body}\n  };\n`,
  });
  const twoWrites = handler(
    `    await deps.counters.execute(counterId, (v) => increment(v, 10), context);\n` +
      `    const second = await deps.counters.execute(counterId + "-copy", (v) => increment(v, 10), context);\n` +
      `    return second.map((executed) => ({ value: executed.state }));`,
  );
  const loop = handler(
    `    for (const id of [counterId, counterId + "-copy"]) await deps.counters.execute(id, (v) => increment(v, 10), context);\n` +
      `    return Result.ok({ value: 0 });`,
  );

  it("rejects CRUD operation names by default", async () => {
    const report = await checkArchitecture(fixture(crud));

    expect(rules(report.violations)).toContain("eslint/projected/business-operation-names");
  });

  it("warns about event names without a past tense by default, accepting irregular ones", async () => {
    const report = await checkArchitecture(fixture(presentTense));

    expect(report.warnings.map((w) => w.message)).toEqual([expect.stringContaining('"CounterRewind" has no past tense')]);
    expect(report.violations).toEqual([]);
  });

  it("rejects a command handler that writes two aggregates", async () => {
    const report = await checkArchitecture(fixture(twoWrites));

    expect(rules(report.violations)).toContain("eslint/projected/single-aggregate-commands");
  });

  it("rejects a command handler that writes aggregates in a loop", async () => {
    const report = await checkArchitecture(fixture(loop));

    expect(report.violations.map((v) => v.message)).toEqual([expect.stringContaining("writes aggregates in a loop")]);
  });

  it("can turn a rule into a warning", async () => {
    const report = await checkArchitecture(fixture(crud), { designRules: { "business-operation-names": "warn" } });

    expect(report.violations).toEqual([]);
    expect(rules(report.warnings)).toEqual(["eslint/projected/business-operation-names"]);
  });

  it("can switch a rule off", async () => {
    const report = await checkArchitecture(fixture(presentTense), { designRules: { "past-tense-events": "off" } });

    expect([report.violations, report.warnings]).toEqual([[], []]);
  });

  it("lets listed handlers write several aggregates", async () => {
    const report = await checkArchitecture(fixture(twoWrites), {
      designRules: { "single-aggregate-commands": { allow: ["src/application/usecase/double.ts"] } },
    });

    expect(report.violations).toEqual([]);
  });

  it("reads the levels from projected.json when none are passed", async () => {
    const report = await checkArchitecture(
      fixture({ ...crud, "projected.json": JSON.stringify({ flavour: "event-sourced", rules: { "business-operation-names": "off" } }) }),
    );

    expect(report.violations).toEqual([]);
  });
});

describe("code rules (ESLint)", () => {
  const cases: Array<[string, Edit, string]> = [
    ["throwing in the domain", { "src/domain/x.ts": `export const f = (): never => { throw new Error("no"); };\n` }, "eslint/no-restricted-syntax"],
    [
      "catching in the application layer",
      { "src/application/usecase/x.ts": `export const f = (g: () => void): void => { try { g(); } catch { /* */ } };\n` },
      "eslint/no-restricted-syntax",
    ],
    ["reading the clock in the domain", { "src/domain/x.ts": `export const now = (): Date => new Date();\n` }, "eslint/no-restricted-syntax"],
    [
      "reading the clock in the application layer",
      { "src/application/usecase/x.ts": `export const now = (): number => Date.now();\n` },
      "eslint/no-restricted-syntax",
    ],
    ["randomness in the domain", { "src/domain/x.ts": `export const roll = (): number => Math.random();\n` }, "eslint/no-restricted-syntax"],
    ["async in the domain", { "src/domain/x.ts": `export const f = async (): Promise<number> => 1;\n` }, "eslint/no-restricted-syntax"],
    [
      "fetch in the application layer",
      { "src/application/usecase/x.ts": `export const f = () => fetch("https://example.com");\n` },
      "eslint/no-restricted-globals",
    ],
    ["logging in the domain", { "src/domain/x.ts": `export const f = (): void => console.log("hi");\n` }, "eslint/no-restricted-globals"],
    ["explicit any", { "src/domain/x.ts": `export const f = (x: any): number => x;\n` }, "eslint/@typescript-eslint/no-explicit-any"],
    [
      "silencing the compiler",
      { "src/domain/x.ts": `// @ts-ignore\nexport const n: number = "one";\n` },
      "eslint/@typescript-eslint/ban-ts-comment",
    ],
  ];

  it.each(cases)("rejects %s", async (_name, edits, expected) => {
    const report = await checkArchitecture(fixture(edits));

    expect(rules(report.violations)).toContain(expected);
  });

  it("ignores eslint-disable comments in production code, and reports them", async () => {
    const report = await checkArchitecture(
      fixture({ "src/domain/x.ts": `// eslint-disable-next-line no-restricted-syntax\nexport const f = (): never => { throw new Error("no"); };\n` }),
    );

    expect(rules(report.violations)).toEqual(["eslint/inline-config", "eslint/no-restricted-syntax"]);
  });

  it("resolves packages' subpath exports in infrastructure", async () => {
    const report = await checkArchitecture(
      fixture({ "src/infrastructure/config/lint.ts": `import { builtinRules } from "eslint/use-at-your-own-risk";\nexport const rules = builtinRules;\n` }),
    );

    expect(report.violations).toEqual([]);
  });

  it("does not apply domain rules to infrastructure", async () => {
    const report = await checkArchitecture(
      fixture({ "src/infrastructure/config/clock.ts": `export const now = (): number => Date.now();\n` }),
    );

    expect(report.violations).toEqual([]);
  });
});

describe("layout and layer tsconfigs", () => {
  const cases: Array<[string, Edit, string]> = [
    ["a file outside every layer", { "src/utils/strings.ts": `export const upper = (s: string): string => s.toUpperCase();\n` }, "layout/known-layers-only"],
    ["a JavaScript source file", { "src/domain/legacy.js": `export const x = 1;\n` }, "layout/typescript-only"],
    [
      "giving the domain Node types",
      { "src/domain/tsconfig.json": (c) => c.replace(`"outDir"`, `"types": ["node"], "outDir"`) },
      "layout/layer-tsconfig",
    ],
    [
      "giving the application the DOM library",
      { "src/application/tsconfig.json": (c) => c.replace(`"outDir"`, `"lib": ["ES2023", "DOM"], "outDir"`) },
      "layout/layer-tsconfig",
    ],
    [
      "letting the application reference infrastructure",
      { "src/application/tsconfig.json": (c) => c.replace(`[{ "path": "../domain" }]`, `[{ "path": "../domain" }, { "path": "../infrastructure" }]`) },
      "layout/layer-tsconfig",
    ],
    [
      "swapping the domain preset",
      { "src/domain/tsconfig.json": (c) => c.replace("tsconfig/domain.json", "tsconfig/infrastructure.json") },
      "layout/layer-tsconfig",
    ],
  ];

  it.each(cases)("rejects %s", async (_name, edits, expected) => {
    const report = await checkArchitecture(fixture(edits));

    expect(rules(report.violations)).toContain(expected);
  });
});

describe("compile-time layer boundaries (tsc -b)", () => {
  const build = async (root: string) => {
    try {
      await promisify(execFile)(process.execPath, [tsc, "-b", root], { cwd: root });
      return "";
    } catch (error) {
      return String((error as { stdout?: string }).stdout ?? error);
    }
  };
  const built = existsSync(join(packages, "domain", "dist", "index.d.ts")) && existsSync(join(packages, "application", "dist", "index.d.ts"));
  const it_ = built ? it : it.skip;

  it_("compiles the clean fixture", async () => {
    expect(await build(fixture())).toBe("");
  }, 60_000);

  it_("makes a domain → application import a compile error", async () => {
    const output = await build(
      fixture({ "src/domain/leak.ts": `import { Increment } from "../application/port/driving/contracts.js";\nexport const x = Increment;\n` }),
    );

    expect(output).toContain("TS6307");
  }, 60_000);

  it_("makes console and fetch unavailable in the domain", async () => {
    const output = await build(fixture({ "src/domain/io.ts": `export const f = () => { console.log("x"); return fetch("x"); };\n` }));

    expect(output).toMatch(/TS2584|TS2304/);
  }, 60_000);

  it_("makes node builtins unavailable in the application layer", async () => {
    const output = await build(
      fixture({ "src/application/usecase/io.ts": `import { readFileSync } from "node:fs";\nexport const f = readFileSync;\n` }),
    );

    expect(output).toMatch(/TS2591|TS2307/);
  }, 60_000);
});
