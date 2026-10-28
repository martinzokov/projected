import { parseArgs } from "node:util";
import { architecture, contractsLock, openapi, type CommandResult } from "./commands.js";
import { docs } from "./docs/commands.js";
import { mutate } from "./mutate.js";
import { operate } from "./operate.js";
import { loadProject } from "./project.js";
import { newAggregate, newCommand, newEventHandler, newPort, newQuery, newService } from "./scaffold/generate.js";
import { vendorAdd, vendorCheck, vendorGenerate, vendorUpdate } from "./vendor/commands.js";

const USAGE = `projected — keep a projected app honest

Usage: projected <command> [--root <dir>] [options]

Commands:
  new service <dir> --flavour event-sourced|state-based --aggregate <name>
                        a new service: layers, composition root, server, tests, and its
                        first aggregate. The flavour is fixed from then on.
  new aggregate <name>  an aggregate, with the property test its flavour requires
  new command <type> --aggregate <name> --event <Event>
                        a contract, its use case, a stub decision recording the event,
                        tests, and the wiring (contracts list, composition root)
  new query <type> --aggregate <name> | --port <Port>
                        a contract and use case reading an aggregate or a read model
  new port <Name> --operations <a,b> [--adapter <factory>]
                        a driven port returning Results, and an adapter for it
  new event-handler <name> --on <Event,...> [--port <Port>]
                        an event handler, registered in the composition root
  operate [<task>] --url <service> [--input <json>] [--token <token>]
                        run an operator task on a running service (rebuild, backlog,
                        replay-dead-letters, ...); without a task, list them. The token
                        (default PROJECTED_OPERATOR_TOKEN) needs projected:operate.
  check [--strict]      everything below, as CI runs it (no files are written);
                        --strict also fails on design-rule warnings
  arch [--strict]       layout, layer tsconfigs, import boundaries, code and design rules
  openapi [--check]     write openapi.json from the contracts, or verify it is current
  contracts [--update] [--allow-removal]
                        verify published contracts are unchanged, or lock new ones
  contracts --rebaseline
                        accept current fingerprints after a toolchain upgrade (review
                        the openapi.json diff first: it must show no contract change)
  mutate                mutation-test the domain and use cases with Stryker;
                        fails below "mutation": { "threshold": n } (default 70)
  docs [--check]        write docs/catalog.md — operations, aggregates, events, handlers,
                        ports and a Mermaid flow diagram, all derived from the code
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
securitySchemes, vendors, rules (design rule levels), docs (catalog path) and mutation
(threshold, files) are optional.`;

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
        flavour: { type: "string" },
        aggregate: { type: "string" },
        event: { type: "string" },
        port: { type: "string" },
        on: { type: "string" },
        operations: { type: "string" },
        adapter: { type: "string" },
        url: { type: "string" },
        input: { type: "string" },
        token: { type: "string" },
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

  const finish = (result: CommandResult) => {
    result.lines.forEach((line) => print(line));
    return result.ok ? 0 : 1;
  };
  if (command === "operate") {
    return finish(await operate(subcommand, { url: values.url, input: values.input, token: values.token }));
  }
  if (command === "new" && subcommand === "service") {
    return finish(newService(values.root, target, { flavour: values.flavour, aggregate: values.aggregate }));
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
        () => docs(project, { check: true }),
      );
      break;
    case "new": {
      const generate = {
        aggregate: () => newAggregate(project, target),
        command: () => newCommand(project, target, { aggregate: values.aggregate, event: values.event }),
        query: () => newQuery(project, target, { aggregate: values.aggregate, port: values.port }),
        port: () => newPort(project, target, { operations: values.operations, adapter: values.adapter }),
        "event-handler": () => newEventHandler(project, target, { on: values.on, port: values.port }),
      }[subcommand ?? ""];
      if (generate === undefined) {
        print(`Unknown kind to create: ${subcommand ?? "(none)"} — service, aggregate, command, query, port or event-handler`);
        return 2;
      }
      return finish(generate());
    }
    case "docs":
      steps.push(() => docs(project, { check: values.check }));
      break;
    case "mutate":
      steps.push(() => mutate(project));
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
