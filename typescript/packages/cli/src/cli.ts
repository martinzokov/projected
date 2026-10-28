import { parseArgs } from "node:util";
import { architecture, contractsLock, openapi, type CommandResult } from "./commands.js";
import { loadProject } from "./project.js";

const USAGE = `projected — keep a projected app honest

Usage: projected <command> [--root <dir>] [options]

Commands:
  check                 everything below, as CI runs it (no files are written)
  arch                  layout, layer tsconfigs, import boundaries and code rules
  openapi [--check]     write openapi.json from the contracts, or verify it is current
  contracts [--update] [--allow-removal]
                        verify published contracts are unchanged, or lock new ones
  contracts --rebaseline
                        accept current fingerprints after a toolchain upgrade (review
                        the openapi.json diff first: it must show no contract change)

Configuration: projected.json in the project root. "flavour" ("event-sourced" or
"state-based") is required; contracts, openapi, lock, applicationPackages, domainPackages
and securitySchemes are optional.`;

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
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    print(String((error as Error).message));
    print(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command] = positionals;
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
        () => architecture(project),
        () => contractsLock(project, { update: false, allowRemoval: false }),
        () => openapi(project, { check: true }),
      );
      break;
    case "arch":
      steps.push(() => architecture(project));
      break;
    case "openapi":
      steps.push(() => openapi(project, { check: values.check }));
      break;
    case "contracts":
      steps.push(() =>
        contractsLock(project, { update: values.update, allowRemoval: values["allow-removal"], rebaseline: values.rebaseline }),
      );
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
