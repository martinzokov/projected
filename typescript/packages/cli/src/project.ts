import type { AnyContracts } from "@projected/application";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

/** `projected.json` at the project root. Every field is optional. */
export interface ProjectConfig {
  /** Module exporting the service's contracts. Defaults to `src/application/port/driving/index.ts`. */
  readonly contracts?: string;
  /** Name of the export, when the module exports more than one contracts set. */
  readonly contractsExport?: string;
  /** Defaults to `openapi.json`. */
  readonly openapi?: string;
  /** Defaults to `contracts.lock.json`. */
  readonly lock?: string;
  /** Extra npm packages the application layer may import (pure libraries only). */
  readonly applicationPackages?: readonly string[];
  /** Extra npm packages the domain layer may import. */
  readonly domainPackages?: readonly string[];
}

export interface Project {
  readonly root: string;
  readonly config: ProjectConfig;
  /** `version` from package.json, used as the OpenAPI document's `info.version`. */
  readonly version: string;
  readonly openapiPath: string;
  readonly lockPath: string;
}

export function loadProject(rootArgument: string): Project {
  const root = isAbsolute(rootArgument) ? rootArgument : resolve(rootArgument);
  const configPath = join(root, "projected.json");
  const config = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf8")) as ProjectConfig) : {};
  const packagePath = join(root, "package.json");
  const version = existsSync(packagePath)
    ? ((JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string }).version ?? "0.0.0")
    : "0.0.0";
  return {
    root,
    config,
    version,
    openapiPath: join(root, config.openapi ?? "openapi.json"),
    lockPath: join(root, config.lock ?? "contracts.lock.json"),
  };
}

const isContracts = (value: unknown): value is AnyContracts =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AnyContracts).name === "string" &&
  Array.isArray((value as AnyContracts).commands) &&
  Array.isArray((value as AnyContracts).queries) &&
  typeof (value as AnyContracts).find === "function";

/** Import the contracts module (TypeScript, loaded with tsx) and find the contracts in it. */
export async function loadContracts(project: Project): Promise<AnyContracts> {
  const modulePath = join(project.root, project.config.contracts ?? "src/application/port/driving/index.ts");
  if (!existsSync(modulePath)) {
    throw new Error(`Contracts module not found: ${modulePath}. Set "contracts" in projected.json.`);
  }
  const module = (await tsImport(pathToFileURL(modulePath).href, import.meta.url)) as Record<string, unknown>;
  const wanted = project.config.contractsExport;
  if (wanted !== undefined) {
    const value = module[wanted];
    if (!isContracts(value)) throw new Error(`Export "${wanted}" of ${modulePath} is not a defineContracts(...) result.`);
    return value;
  }
  const candidates = Object.entries(module).filter(([, value]) => isContracts(value));
  if (candidates.length !== 1) {
    throw new Error(
      `${modulePath} must export exactly one defineContracts(...) result, found ${candidates.length}. ` +
        `Set "contractsExport" in projected.json to choose.`,
    );
  }
  return candidates[0]?.[1] as AnyContracts;
}
