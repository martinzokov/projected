import { parseArgs } from "node:util";
import { architecture, contractsLock, openapi, type CommandResult } from "./commands.js";
import { docs } from "./docs/commands.js";
import { installAgents } from "./agents.js";
import { conformance } from "./conformance.js";
import { HARNESSES, guard, type Harness } from "./guard.js";
import { loadMigrations, migrate } from "./migrate.js";
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
  guard [--full] [--strict] [--staged] [--files <a,b>] [--hook <harness>]
                        what a coding agent runs as it works: the rules on the files that
                        changed (from git), or with --full the whole gate (compile, tests,
                        check). --hook answers a claude-code, cursor or codex hook.
  agents install [--harness claude-code,cursor,codex] [--no-git-hook]
                        set the project up for coding agents: AGENTS.md, the skills, each
                        harness's rules and hooks, and a git pre-commit hook
  conformance --url <service> [--suite protocol|school|<file>]... [--token <name>=<token>]...
                        run the language-neutral black-box scenarios (spec/conformance)
                        against a running service, in any language
  operate [<task>] --url <service> [--input <json>] [--token <token>]
                        run an operator task on a running service (rebuild, backlog,
                        replay-dead-letters, ...); without a task, list them. The token
                        (default PROJECTED_OPERATOR_TOKEN) needs projected:operate.
  migrate [--check]     bring the service's tables up to date (projected's, better-auth's,
                        its own) as a deploy step, before the new version starts; --check
                        changes nothing and fails while changes are pending
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
securitySchemes, vendors, rules (design rule levels), docs (catalog path), migrations
(the module listing the service's schema migrators) and mutation (threshold, files) are
optional.`;

/** The whole of standard input, for hook events; empty when it is a terminal. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Run the CLI. Returns the process exit code: 0 ok, 1 checks failed, 2 usage error — or, for
 * `guard --hook`, what the agent's harness reads (2 hands stderr to the agent).
 */
export async function run(argv: readonly string[], print: (line: string) => void, printError: (line: string) => void = print): Promise<number> {
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
        full: { type: "boolean", default: false },
        staged: { type: "boolean", default: false },
        files: { type: "string" },
        hook: { type: "string" },
        harness: { type: "string" },
        "no-git-hook": { type: "boolean", default: false },
        input: { type: "string" },
        token: { type: "string", multiple: true },
        suite: { type: "string", multiple: true },
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
    return finish(await operate(subcommand, { url: values.url, input: values.input, token: values.token?.at(-1) }));
  }
  if (command === "conformance") {
    if (values.url === undefined) {
      print("conformance: name the running service with --url <base url>");
      return 2;
    }
    const tokens = Object.fromEntries((values.token ?? []).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
    return finish(await conformance({ url: values.url, ...(values.suite === undefined ? {} : { suites: values.suite }), tokens }));
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
    case "guard": {
      const hook = values.hook as Harness | undefined;
      if (hook !== undefined && !HARNESSES.includes(hook)) {
        print(`Unknown harness: ${hook} — ${HARNESSES.join(", ")}`);
        return 2;
      }
      const outcome = await guard(project, {
        full: values.full,
        strict: values.strict,
        staged: values.staged,
        files: values.files?.split(",").filter((file) => file !== ""),
        hook,
        stdin: hook === undefined ? "" : await readStdin(),
      });
      outcome.stdout.forEach((line) => print(line));
      outcome.stderr.forEach((line) => printError(line));
      return outcome.exitCode;
    }
    case "agents": {
      if (subcommand !== "install") {
        print(`Unknown agents command: ${subcommand ?? "(none)"} — install`);
        return 2;
      }
      const harnesses = values.harness?.split(",").filter((h) => h !== "") as Harness[] | undefined;
      return finish(installAgents(project, { ...(harnesses === undefined ? {} : { harnesses }), gitHook: !values["no-git-hook"] }));
    }
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
    case "migrate":
      steps.push(async () => {
        const migrations = await loadMigrations(project);
        try {
          return await migrate(migrations, { check: values.check });
        } finally {
          await migrations.close?.();
        }
      });
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
