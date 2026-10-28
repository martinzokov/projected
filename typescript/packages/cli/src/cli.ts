import { parseArgs } from "node:util";
import { architecture, contractsLock, openapi, type CommandResult } from "./commands.js";
import { loadProject } from "./project.js";
import { vendorAdd, vendorCheck, vendorGenerate, vendorUpdate } from "./vendor/commands.js";

const USAGE = `projected — keep a projected app honest

Usage: projected <command> [--root <dir>] [options]

Commands:
  check [--strict]      everything below, as CI runs it (no files are written);
                        --strict also fails on design-rule warnings
  arch [--strict]       layout, layer tsconfigs, import boundaries, code and design rules
  openapi [--check]     write openapi.json from the contracts, or verify it is current
  contracts [--update] [--allow-removal]
                        verify published contracts are unchanged, or lock new ones
  contracts --rebaseline
                        accept current fingerprints after a toolchain upgrade (review
                        the openapi.json diff first: it must show no contract change)
  vendor add <name> --spec <url|file>
                        pin a third-party OpenAPI spec and generate a Result-returning
                        client for it (plus a starter port and adapter)
  vendor update <name> [--spec <url|file>] [--accept-breaking]
                        take a new version of the spec; refuses breaking changes unless
                        accepted
  vendor generate [<name>]
                        regenerate clients from the pinned specs

Configuration: projected.json in the project root. "flavour" ("event-sourced" or
"state-based") is required; contracts, openapi, lock, applicationPackages, domainPackages,
securitySchemes, vendors and rules (design rule levels) are optional.`;

/** Run the CLI. Returns the process exit code: 0 ok, 1 checks failed, 2 usage error. */
export async function run(argv: readonly string[], print: (line: string) => void): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        root: { type: "string", default: "." },
        check: { type: "boolean", default: false },
        update: { type: "boolean", default: false },
        "allow-removal": { type: "boolean", default: false },
        rebaseline: { type: "boolean", default: false },
        spec: { type: "string" },
        "accept-breaking": { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    print(String((error as Error).message));
    print(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, subcommand, target] = positionals;
  if (values.help || command === undefined) {
    print(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }

  let project;
  try {
    project = loadProject(values.root);
  } catch (error) {
    print(`error: ${(error as Error).message}`);
    return 1;
  }
  const steps: Array<() => Promise<CommandResult>> = [];
  switch (command) {
    case "check":
      steps.push(
        () => architecture(project, { strict: values.strict }),
        () => contractsLock(project, { update: false, allowRemoval: false }),
        () => openapi(project, { check: true }),
        async () => vendorCheck(project),
      );
      break;
    case "arch":
      steps.push(() => architecture(project, { strict: values.strict }));
      break;
    case "openapi":
      steps.push(() => openapi(project, { check: values.check }));
      break;
    case "contracts":
      steps.push(() =>
        contractsLock(project, { update: values.update, allowRemoval: values["allow-removal"], rebaseline: values.rebaseline }),
      );
      break;
    case "vendor":
      if (subcommand === "add") steps.push(() => vendorAdd(project, target, values.spec));
      else if (subcommand === "update") {
        steps.push(() => vendorUpdate(project, target, { ...(values.spec === undefined ? {} : { source: values.spec }), acceptBreaking: values["accept-breaking"] }));
      } else if (subcommand === "generate") steps.push(async () => vendorGenerate(project, target));
      else {
        print(`Unknown vendor command: ${subcommand ?? "(none)"}`);
        print(USAGE);
        return 2;
      }
      break;
    default:
      print(`Unknown command: ${command}`);
      print(USAGE);
      return 2;
  }

  let ok = true;
  for (const step of steps) {
    try {
      const result = await step();
      result.lines.forEach((line) => print(line));
      ok &&= result.ok;
    } catch (error) {
      print(`error: ${(error as Error).message}`);
      ok = false;
    }
  }
  return ok ? 0 : 1;
}
