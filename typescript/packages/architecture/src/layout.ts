import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** One broken architecture rule. */
export interface Violation {
  /** Which check found it: `layout`, `dependency-cruiser` or `eslint`. */
  readonly tool: "layout" | "dependency-cruiser" | "eslint";
  readonly rule: string;
  /** Path relative to the project root. */
  readonly file: string;
  readonly line?: number;
  /** What is wrong and how to fix it, written for whoever hits it. */
  readonly message: string;
}

const LAYER_PATH =
  /^src\/(domain\/|application\/(port\/(driving|driven)|usecase)\/|infrastructure\/(adapter\/(driving|driven)\/[^/]+\/|config\/))/;
const SOURCE = /\.(ts|mts|cts|tsx)$/;
const SCRIPT = /\.(js|mjs|cjs|jsx)$/;
const PRESET = (layer: string) => `@projected/architecture/tsconfig/${layer}.json`;

function filesUnder(root: string, dir: string, pattern: RegExp): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(join(root, path)).isDirectory()) return filesUnder(root, path, pattern);
    return pattern.test(entry) && !entry.endsWith(".d.ts") ? [path.split(sep).join("/")] : [];
  });
}

interface TsConfigJson {
  extends?: string | string[];
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  files?: string[];
  references?: Array<{ path: string }>;
}

function readTsConfig(path: string): TsConfigJson | string {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error !== undefined) return ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n");
  return parsed.config as TsConfigJson;
}

const normalize = (path: string) => path.replace(/\/+$/, "").replace(/^\.\//, "");

/**
 * Check the parts of the architecture that live in the file system rather than in imports:
 * every source file sits in a known layer, and each layer's tsconfig still has the restrictions
 * that make boundary violations compile errors. Editing a layer's tsconfig to add `"types":
 * ["node"]` or a new reference would silently re-open the boundary — this check refuses it.
 */
export function checkLayout(root: string): Violation[] {
  const violations: Violation[] = [];
  const fail = (rule: string, file: string, message: string) => violations.push({ tool: "layout", rule, file, message });

  for (const required of ["src/domain", "src/application", "src/infrastructure/config"]) {
    if (!existsSync(join(root, required))) fail("required-layers", required, `Missing ${required}/. Every projected app has it.`);
  }

  for (const file of filesUnder(root, "src", SCRIPT)) {
    fail("typescript-only", file, "Write source files in TypeScript: JavaScript files escape the compile-time layer checks.");
  }

  for (const file of filesUnder(root, "src", SOURCE)) {
    if (!LAYER_PATH.test(file)) {
      fail(
        "known-layers-only",
        file,
        "Every source file belongs to a layer: src/domain, src/application/(port/driving|port/driven|usecase), " +
          "src/infrastructure/adapter/(driving|driven)/<name> or src/infrastructure/config. Move this file into one.",
      );
    }
  }

  const layers = [
    { layer: "domain", references: [] as string[], restricted: true },
    { layer: "application", references: ["../domain"], restricted: true },
    { layer: "infrastructure", references: ["../domain", "../application"], restricted: false },
  ];
  for (const { layer, references, restricted } of layers) {
    const file = `src/${layer}/tsconfig.json`;
    const path = join(root, file);
    if (!existsSync(path)) {
      fail("layer-tsconfig", file, `Missing ${file}. Each layer is its own TypeScript project; see the projected templates.`);
      continue;
    }
    const config = readTsConfig(path);
    if (typeof config === "string") {
      fail("layer-tsconfig", file, `Cannot parse: ${config}`);
      continue;
    }
    if (config.extends !== PRESET(layer)) {
      fail("layer-tsconfig", file, `Must extend "${PRESET(layer)}" — the preset is what removes Node and DOM from this layer.`);
    }
    const options = config.compilerOptions ?? {};
    const loosened = ["lib", "types", "typeRoots", "paths", "baseUrl", "noLib", "allowJs"].filter(
      (option) => option in options,
    );
    if (restricted && loosened.length > 0) {
      fail(
        "layer-tsconfig",
        file,
        `Must not set ${loosened.join(", ")}: the ${layer} layer compiles without Node or DOM on purpose. ` +
          "Reach I/O through a port instead of widening the compiler.",
      );
    }
    for (const pattern of [...(config.include ?? []), ...(config.files ?? [])]) {
      if (pattern.includes("..")) fail("layer-tsconfig", file, `"${pattern}" reaches outside src/${layer}; a layer includes only itself.`);
    }
    const actual = (config.references ?? []).map((reference) => normalize(reference.path)).sort();
    const expected = [...references].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(
        "layer-tsconfig",
        file,
        `References must be exactly [${expected.join(", ") || "none"}], found [${actual.join(", ") || "none"}]. ` +
          "References are the compile-time dependency graph between layers.",
      );
    }
  }
  return violations.map((violation) => ({ ...violation, file: relative(root, join(root, violation.file)) || violation.file }));
}
