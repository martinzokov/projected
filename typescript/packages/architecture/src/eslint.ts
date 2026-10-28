import type { ESLint, Linter } from "eslint";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import tseslint from "typescript-eslint";
import { businessOperationNames } from "./rules/business-operation-names.js";
import { drivenAdaptersReturnResults } from "./rules/driven-adapters-return-results.js";
import { drivenPortsReturnResults } from "./rules/driven-ports-return-results.js";
import { pastTenseEvents } from "./rules/past-tense-events.js";
import { singleAggregateCommands } from "./rules/single-aggregate-commands.js";

/** How strictly a design rule is applied. Warnings are reported; `projected check --strict` fails on them. */
export type RuleLevel = "error" | "warn" | "off";

/**
 * Design rules: judgement calls about naming and boundaries that a team may relax to warnings
 * (or switch off) in `projected.json` under `"rules"`. Layer boundaries, determinism, Results and
 * contract immutability are not on this list: they are never configurable.
 */
export interface DesignRules {
  readonly "business-operation-names"?: RuleLevel;
  readonly "past-tense-events"?: RuleLevel;
  /** `allow` lists use case files (relative to the project root) that may write several aggregates. */
  readonly "single-aggregate-commands"?: RuleLevel | { readonly level?: RuleLevel; readonly allow?: readonly string[] };
}

export const DESIGN_RULE_DEFAULTS: Readonly<Record<keyof DesignRules, RuleLevel>> = {
  "business-operation-names": "error",
  // A heuristic over English words: it can be wrong, so it informs rather than blocks.
  "past-tense-events": "warn",
  "single-aggregate-commands": "error",
};

const levelOf = (rules: DesignRules, rule: keyof DesignRules): RuleLevel => {
  const setting = rules[rule];
  return (typeof setting === "object" ? setting.level : setting) ?? DESIGN_RULE_DEFAULTS[rule];
};

/** The design rules from `projected.json`, when the caller passes none (editor integrations). */
function designRulesAt(root: string): DesignRules {
  const path = join(root, "projected.json");
  if (!existsSync(path)) return {};
  try {
    return ((JSON.parse(readFileSync(path, "utf8")) as { rules?: DesignRules }).rules ?? {}) as DesignRules;
  } catch {
    return {};
  }
}

/** projected's own rules, as an ESLint plugin registered under the `projected/` prefix. */
export const projectedPlugin: ESLint.Plugin = {
  meta: { name: "@projected/architecture" },
  rules: {
    "driven-ports-return-results": drivenPortsReturnResults,
    "driven-adapters-return-results": drivenAdaptersReturnResults,
    "business-operation-names": businessOperationNames,
    "past-tense-events": pastTenseEvents,
    "single-aggregate-commands": singleAggregateCommands,
  },
};

/**
 * Code-level rules for a projected app, as an ESLint flat config. They cover what import rules
 * and the compiler cannot: determinism and error handling inside the domain and application
 * layers, and the bypass comments that would turn enforcement back into convention.
 */

type Restriction = { readonly selector: string; readonly message: string };

const DETERMINISM: readonly Restriction[] = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: "Do not read the clock here. Take the time as input, or inject the Clock port in the use case.",
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: "Do not read the clock here. Take the time as input, or inject the Clock port in the use case.",
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: "Randomness makes decisions unreproducible. Inject the IdGenerator port, or take the value as input.",
  },
];

const RESULTS_NOT_EXCEPTIONS: readonly Restriction[] = [
  {
    selector: "ThrowStatement",
    message:
      "Expected failures are values: return Result.err(new SomeError(...)) with an error from defineError. " +
      "A broken invariant is a defect: call panic(...) from @projected/domain.",
  },
  {
    selector: "TryStatement",
    message:
      "Do not catch exceptions here. Ports return Results; defects are caught and reported by the framework. " +
      "For a throwing pure function you must call, use Result.try(...).",
  },
];

const SYNCHRONOUS_DOMAIN: readonly Restriction[] = [
  {
    selector: ":function[async=true]",
    message:
      "The domain is synchronous: decisions are pure functions of state and input. Load what a decision needs in " +
      "the use case and pass it in.",
  },
  {
    selector: "AwaitExpression",
    message: "The domain is synchronous. Do the asynchronous work in the use case and pass the result in.",
  },
];

const IO_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "process",
  "require",
  "Buffer",
  "crypto",
  "performance",
  "console",
  "localStorage",
  "sessionStorage",
].map((name) => ({
  name,
  message: `\`${name}\` is I/O or ambient state. Reach the outside world through a port (src/application/port/driven), wired in src/infrastructure/config.`,
}));

export interface EslintOptions {
  /** Defaults to `["src"]`. */
  readonly sourceDirs?: readonly string[];
  /** Where typed rules look for tsconfig files. Defaults to the working directory. */
  readonly tsconfigRootDir?: string;
  /** Design rule levels. Defaults to the `"rules"` of `projected.json` in `tsconfigRootDir`. */
  readonly designRules?: DesignRules;
}

/**
 * The projected ESLint config. In `eslint.config.js`:
 *
 * ```js
 * import { projectedEslint } from "@projected/architecture/eslint";
 * export default projectedEslint();
 * ```
 *
 * `projected check` runs these rules itself, ignoring local config files, so CI cannot be
 * weakened by editing them — the local file only drives editor integration.
 */
export function projectedEslint(options: EslintOptions = {}): Linter.Config[] {
  const dirs = options.sourceDirs ?? ["src"];
  const root = options.tsconfigRootDir ?? process.cwd();
  const design = options.designRules ?? designRulesAt(root);
  const several = design["single-aggregate-commands"];
  const allowedSeveral = typeof several === "object" ? (several.allow ?? []) : [];
  const glob = (layer: string) => dirs.map((dir) => `${dir}/${layer}**/*.{ts,mts,cts,tsx}`);
  const plugins = {
    "@typescript-eslint": tseslint.plugin as unknown as NonNullable<Linter.Config["plugins"]>[string],
    projected: projectedPlugin,
  };

  return [
    { ignores: ["**/dist/**", "**/.tsbuild/**", "**/node_modules/**"] },
    {
      name: "projected/source",
      files: glob(""),
      languageOptions: { parser: tseslint.parser as Linter.Parser },
      plugins,
      // Inline `eslint-disable` comments are ignored in production code: a rule that can be
      // switched off by the code it checks is a convention, not a rule.
      linterOptions: { noInlineConfig: true },
      rules: {
        "@typescript-eslint/ban-ts-comment": [
          "error",
          { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true, "ts-check": false },
        ],
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/triple-slash-reference": ["error", { path: "never", types: "never", lib: "never" }],
      },
    },
    {
      name: "projected/application",
      files: glob("application/"),
      rules: {
        "no-restricted-syntax": ["error", ...DETERMINISM, ...RESULTS_NOT_EXCEPTIONS],
        "no-restricted-globals": ["error", ...IO_GLOBALS],
      },
    },
    {
      name: "projected/driven-ports",
      files: glob("application/port/driven/"),
      rules: { "projected/driven-ports-return-results": "error" },
    },
    {
      // Typed: whether an awaited promise holds a Result is a question for the type checker.
      name: "projected/driven-adapters",
      files: glob("infrastructure/adapter/driven/"),
      languageOptions: {
        parser: tseslint.parser as Linter.Parser,
        parserOptions: { projectService: true, tsconfigRootDir: root },
      },
      rules: { "projected/driven-adapters-return-results": "error" },
    },
    {
      name: "projected/design/operation-names",
      files: glob("application/port/driving/"),
      rules: { "projected/business-operation-names": levelOf(design, "business-operation-names") },
    },
    {
      name: "projected/design/event-names",
      files: glob("domain/"),
      rules: { "projected/past-tense-events": levelOf(design, "past-tense-events") },
    },
    {
      name: "projected/design/single-aggregate",
      files: glob("application/usecase/"),
      ignores: [...allowedSeveral],
      languageOptions: {
        parser: tseslint.parser as Linter.Parser,
        parserOptions: { projectService: true, tsconfigRootDir: root },
      },
      rules: { "projected/single-aggregate-commands": levelOf(design, "single-aggregate-commands") },
    },
    {
      name: "projected/domain",
      files: glob("domain/"),
      rules: {
        "no-restricted-syntax": ["error", ...DETERMINISM, ...RESULTS_NOT_EXCEPTIONS, ...SYNCHRONOUS_DOMAIN],
        "no-restricted-globals": ["error", ...IO_GLOBALS],
      },
    },
  ];
}

export default projectedEslint;
