import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { FLAVOURS, type Flavour } from "@projected/architecture";
import type { CommandResult } from "../commands.js";
import type { Project } from "../project.js";
import {
  camel,
  checkAggregateName,
  checkCamelList,
  checkKebab,
  checkOperationType,
  checkPascal,
  decisionName,
  kebab,
  pascal,
  plural,
  sentence,
  type NameCheck,
} from "./names.js";
import { Source, arrayIn, describeBody, exportedNames, findCall, objectIn, propertyOf } from "./source.js";
import {
  adapterModule,
  aggregateFiles,
  commandUseCase,
  contractModule,
  decisionFunction,
  decisionTest,
  eventDefinition,
  eventHandlerModule,
  eventsModule,
  httpTest,
  phrase,
  PNPM_WORKSPACE,
  portModule,
  queryUseCase,
  serviceFiles,
} from "./templates.js";

/** A generator stopping before it writes anything, with the reason for whoever ran it. */
class Refused extends Error {}

const refuseUnless = (check: NameCheck) => {
  if (!check.ok) throw new Refused(check.message);
};

/**
 * The files a generator creates and changes, held until every check has passed: a generator
 * that refuses leaves the project exactly as it was.
 */
class Changes {
  private readonly created = new Map<string, string>();
  private readonly edited = new Map<string, Source>();
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  exists(file: string): boolean {
    return this.created.has(file) || existsSync(join(this.root, file));
  }

  create(file: string, content: string): void {
    if (this.exists(file)) throw new Refused(`${file} already exists`);
    this.created.set(file, content);
  }

  edit(file: string): Source {
    const existing = this.edited.get(file);
    if (existing !== undefined) return existing;
    const created = this.created.get(file);
    const source = created === undefined ? Source.read(join(this.root, file)) : Source.of(join(this.root, file), created);
    this.edited.set(file, source);
    return source;
  }

  write(): string[] {
    const lines: string[] = [];
    for (const [file, content] of this.created) {
      const final = this.edited.get(file)?.content ?? content;
      mkdirSync(dirname(join(this.root, file)), { recursive: true });
      writeFileSync(join(this.root, file), final);
      lines.push(`new: created ${file}`);
    }
    for (const [file, source] of this.edited) {
      if (this.created.has(file)) continue;
      source.save();
      lines.push(`new: changed ${file}`);
    }
    return lines;
  }
}

function tsFiles(root: string, dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

const parse = (root: string, file: string) => ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);

/** `import` specifier of `to` from `from`, both relative to the project root. */
function moduleFrom(from: string, to: string): string {
  const path = relative(dirname(from), to).replace(/\.ts$/, ".js");
  return path.startsWith(".") ? path : `./${path}`;
}

interface Found {
  readonly file: string;
  readonly name: string;
}

/** The exported `const` whose initializer is `call(...)` and whose first argument passes `matches`. */
function findDefinition(root: string, dir: string, call: string, matches: (argument: ts.Expression) => boolean): Found | undefined {
  for (const file of tsFiles(root, dir)) {
    for (const statement of parse(root, file).statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          init !== undefined &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === call &&
          init.arguments[0] !== undefined &&
          matches(init.arguments[0])
        ) {
          return { file, name: declaration.name.text };
        }
      }
    }
  }
  return undefined;
}

const findAggregate = (root: string, name: string) =>
  findDefinition(root, "src/domain", "defineAggregate", (options) => {
    const value = propertyOf(options, "name");
    return value !== undefined && ts.isStringLiteralLike(value) && value.text === name;
  });

const findEvent = (root: string, type: string) =>
  findDefinition(root, "src/domain", "defineEvent", (argument) => ts.isStringLiteralLike(argument) && argument.text === type);

function findInterface(root: string, dir: string, name: string): string | undefined {
  return tsFiles(root, dir).find((file) => parse(root, file).statements.some((s) => ts.isInterfaceDeclaration(s) && s.name.text === name));
}

/** The composition root: the one file in src/infrastructure/config that calls `createApplication`. */
function compositionRoot(root: string): string {
  const files = tsFiles(root, "src/infrastructure/config").filter((file) => findCall(parse(root, file), "createApplication") !== undefined);
  if (files.length !== 1) {
    throw new Refused(
      files.length === 0
        ? "no composition root: no file in src/infrastructure/config calls createApplication"
        : `more than one composition root calls createApplication (${files.join(", ")}); the generators wire into exactly one`,
    );
  }
  return files[0]!;
}

const contractsModule = (project: Project) => project.config.contracts ?? "src/application/port/driving/index.ts";

function serviceName(project: Project): string {
  const file = contractsModule(project);
  const value = existsSync(join(project.root, file)) ? propertyOf(findCall(parse(project.root, file), "defineContracts")?.arguments[0], "name") : undefined;
  if (value === undefined || !ts.isStringLiteralLike(value)) throw new Refused(`${file} must call defineContracts({ name: "...", ... })`);
  return value.text;
}

/** The statement `return createApplication(...)` and the function body around it. */
function returnOfApplication(source: ts.SourceFile): ts.ReturnStatement | undefined {
  let node: ts.Node | undefined = findCall(source, "createApplication");
  while (node !== undefined && !ts.isReturnStatement(node)) node = node.parent;
  return node;
}

function composeBody(source: ts.SourceFile): ts.Block | undefined {
  const statement = returnOfApplication(source);
  return statement !== undefined && ts.isBlock(statement.parent) ? statement.parent : undefined;
}

/** `const { a, b } = infrastructure` in the composition root. */
function infrastructureBindings(source: ts.SourceFile): ts.ObjectBindingPattern | undefined {
  for (const statement of composeBody(source)?.statements ?? []) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isObjectBindingPattern(declaration.name) && declaration.initializer !== undefined && ts.isIdentifier(declaration.initializer)) {
        return declaration.name;
      }
    }
  }
  return undefined;
}

/** Local `const` names in the composition root, with what each is initialised by. */
function composeVariables(source: ts.SourceFile): Map<string, ts.Expression> {
  const variables = new Map<string, ts.Expression>();
  for (const statement of composeBody(source)?.statements ?? []) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) variables.set(declaration.name.text, declaration.initializer);
    }
  }
  return variables;
}

const STORE: Record<Flavour, string> = { "event-sourced": "eventStore", "state-based": "stateStore" };

/** What the composition root can pass an adapter factory, by parameter type. */
const PROVIDED: Record<string, string> = { DocumentStore: "documents", Clock: "clock", IdGenerator: "ids", Telemetry: "telemetry" };

class Wiring {
  readonly source: Source;
  private readonly project: Project;
  readonly file: string;

  constructor(project: Project, changes: Changes, file: string) {
    this.project = project;
    this.file = file;
    this.source = changes.edit(file);
  }

  private uses(name: string) {
    if (!this.source.addBinding(infrastructureBindings, name)) {
      throw new Refused(`${this.file}: the composition root must destructure its infrastructure (const { ... } = infrastructure) for the generators to use ${name}`);
    }
  }

  private declare(code: string) {
    if (!this.source.insertBefore(returnOfApplication, code)) throw new Refused(`${this.file}: no \`return createApplication(...)\` to wire into`);
  }

  /** The variable holding the aggregate's repository, declared if it is not there yet. */
  repository(aggregate: Found): string {
    for (const [name, init] of composeVariables(this.source.parse())) {
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "aggregateRepository") {
        const first = init.arguments[0];
        if (first !== undefined && ts.isIdentifier(first) && first.text === aggregate.name) return name;
      }
    }
    const store = STORE[this.project.flavour];
    const variable = plural(camel(aggregate.name));
    this.uses(store);
    this.uses("telemetry");
    this.source.addImport(`@projected/application/${this.project.flavour}`, ["aggregateRepository"]);
    this.source.addImport(moduleFrom(this.file, aggregate.file), [aggregate.name]);
    this.declare(`const ${variable} = aggregateRepository(${aggregate.name}, ${store}, telemetry === undefined ? {} : { telemetry });`);
    return variable;
  }

  /** The variable holding the port's adapter, declared from the port's one adapter if it is not there yet. */
  port(port: string): string {
    const variable = camel(port);
    if (composeVariables(this.source.parse()).has(variable)) return variable;
    const adapters = adapterFactories(this.project.root, port);
    if (adapters.length !== 1) {
      throw new Refused(
        adapters.length === 0
          ? `no adapter implements ${port} in src/infrastructure/adapter/driven (an exported function returning ${port}); add one with \`projected new port\`, or declare \`const ${variable} = …\` in ${this.file}`
          : `${port} has several adapters (${adapters.map((a) => a.name).join(", ")}): declare the one to use as \`const ${variable} = …\` in ${this.file}, then run this again`,
      );
    }
    const adapter = adapters[0]!;
    const args = adapter.parameters.map((type) => {
      const provided = PROVIDED[type];
      if (provided === undefined) throw new Refused(`${adapter.name} takes a ${type}, which the composition root does not have: declare \`const ${variable} = ${adapter.name}(…)\` in ${this.file}, then run this again`);
      this.uses(provided);
      return provided;
    });
    this.source.addImport(moduleFrom(this.file, adapter.file), [adapter.name]);
    this.declare(`const ${variable} = ${adapter.name}(${args.join(", ")});`);
    return variable;
  }

  bind(kind: "commands" | "queries", key: string, handler: string, module: string) {
    this.source.addImport(moduleFrom(this.file, module), [handler.replace(/\(.*$/, "")]);
    if (!this.source.addProperty(objectIn("createApplication", kind, 1), `"${key}": ${handler}`)) {
      throw new Refused(`${this.file}: createApplication(contracts, { ${kind}: { ... } }) must be an object literal for the generators to bind ${key}`);
    }
  }

  handle(handler: string, module: string) {
    this.source.addImport(moduleFrom(this.file, module), [handler.replace(/\(.*$/, "")]);
    if (!this.source.appendElement(arrayIn("createApplication", "eventHandling.handlers", 1), handler)) {
      throw new Refused(`${this.file}: createApplication(contracts, { eventHandling: { handlers: [...] } }) must be an array literal for the generators to add ${handler}`);
    }
  }
}

function adapterFactories(root: string, port: string): Array<{ file: string; name: string; parameters: string[] }> {
  const found: Array<{ file: string; name: string; parameters: string[] }> = [];
  for (const file of tsFiles(root, "src/infrastructure/adapter/driven")) {
    for (const statement of parse(root, file).statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name !== undefined &&
        statement.type !== undefined &&
        ts.isTypeReferenceNode(statement.type) &&
        statement.type.typeName.getText() === port &&
        ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        found.push({ file, name: statement.name.text, parameters: statement.parameters.map((p) => p.type?.getText() ?? "unknown") });
      }
    }
  }
  return found;
}

function register(changes: Changes, project: Project, kind: "commands" | "queries", contract: string, contractFile: string) {
  const index = contractsModule(project);
  const source = changes.edit(index);
  source.addImport(moduleFrom(index, contractFile), [contract]);
  if (!source.appendElement(arrayIn("defineContracts", kind), contract)) {
    throw new Refused(`${index}: defineContracts({ ${kind}: [...] }) must be an array literal for the generators to add ${contract}`);
  }
}

/** Add an HTTP test to `describe("<service> over HTTP")` in test/http.test.ts, when there is one. */
function addHttpTest(changes: Changes, service: string, code: string): boolean {
  if (!changes.exists("test/http.test.ts")) return false;
  return changes.edit("test/http.test.ts").appendStatement(describeBody(`${service} over HTTP`), code);
}

const regenerate = "then `projected openapi`, `projected contracts --update` and `projected docs`, and `pnpm check`";

function run(project: Project, generate: (changes: Changes) => string[]): CommandResult {
  const changes = new Changes(project.root);
  try {
    const next = generate(changes);
    return { ok: true, lines: [...changes.write(), ...next] };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, lines: [`new: ${error.message} — nothing was written`] };
    throw error;
  }
}

/** `projected new aggregate <name>`. */
export function newAggregate(project: Project, name: string | undefined): CommandResult {
  return run(project, (changes) => {
    if (name === undefined) throw new Refused("name the aggregate: projected new aggregate <name>, e.g. invoice");
    refuseUnless(checkAggregateName(name));
    if (findAggregate(project.root, name) !== undefined) throw new Refused(`aggregate ${name} already exists`);
    for (const [file, content] of Object.entries(aggregateFiles({ flavour: project.flavour, name }, kebab(name)))) changes.create(file, content);
    return [`next: give it commands — projected new command <type> --aggregate ${name} --event <Event>`];
  });
}

/** `projected new command <type> --aggregate <name> --event <Event>`. */
export function newCommand(project: Project, type: string | undefined, options: { aggregate?: string | undefined; event?: string | undefined }): CommandResult {
  return run(project, (changes) => {
    if (type === undefined) throw new Refused("name the command: projected new command <type> --aggregate <name> --event <Event>, e.g. issue-invoice");
    refuseUnless(checkOperationType(type, "command"));
    const { aggregate: aggregateName, event } = options;
    if (aggregateName === undefined) throw new Refused("a command changes one aggregate: name it with --aggregate <name>");
    if (event === undefined) throw new Refused(`name the event ${type} records, in the past tense: --event <Event>, e.g. InvoiceIssued`);
    refuseUnless(checkPascal(event, "event", "InvoiceIssued"));
    const aggregate = findAggregate(project.root, aggregateName);
    if (aggregate === undefined) throw new Refused(`no aggregate ${aggregateName} in src/domain; create it with \`projected new aggregate ${aggregateName}\``);
    if (findEvent(project.root, event) !== undefined) {
      throw new Refused(`event ${event} already exists; a generated command records a new event — write a command for an existing one by hand`);
    }
    const flavour = project.flavour;
    const decision = decisionName(type, aggregateName);
    if (exportedNames(parse(project.root, aggregate.file)).has(decision)) {
      throw new Refused(`${aggregate.file} already exports ${decision}, the decision ${type} would call`);
    }
    const idField = `${aggregateName}Id`;
    const eventsFile = join(dirname(aggregate.file), "events.ts");
    const contractFile = `src/application/port/driving/${type}.ts`;
    const useCaseFile = `src/application/usecase/${type}.ts`;

    // The domain: the event, the aggregate recording it, and the decision.
    if (!changes.exists(eventsFile)) changes.create(eventsFile, eventsModule(flavour, aggregateName));
    changes.edit(eventsFile).append(eventDefinition(event, idField));
    const domain = changes.edit(aggregate.file);
    domain.addImport(`@projected/domain/${flavour}`, flavour === "event-sourced" ? ["Result"] : ["Result", "changeTo"], ["Decision"]);
    domain.addImport(moduleFrom(aggregate.file, eventsFile), [event]);
    if (!domain.appendElement(arrayIn("defineAggregate", "events"), event)) throw new Refused(`${aggregate.file}: defineAggregate({ events: [...] }) must be an array literal`);
    if (flavour === "event-sourced" && !domain.addProperty(objectIn("defineAggregate", "evolve"), `${event}: (state) => state`)) {
      throw new Refused(`${aggregate.file}: defineAggregate({ evolve: { ... } }) must be an object literal`);
    }
    domain.append(decisionFunction(flavour, decision, aggregateName, event, idField));

    // The contract, its use case, and the wiring.
    changes.create(contractFile, contractModule({ flavour, kind: "command", type, idField }, sentence(type)));
    const repository = plural(aggregateName);
    changes.create(
      useCaseFile,
      commandUseCase({ flavour, type, aggregate: { name: aggregateName, module: moduleFrom(useCaseFile, aggregate.file), repository, idField } }, decision),
    );
    register(changes, project, "commands", pascal(type), contractFile);
    const wiring = new Wiring(project, changes, compositionRoot(project.root));
    const variable = wiring.repository(aggregate);
    wiring.bind("commands", `${type}@1`, `${camel(type)}({ ${variable === repository ? repository : `${repository}: ${variable}`} })`, useCaseFile);

    // Tests: the decision, and the endpoint.
    const domainTest = `test/domain/${kebab(aggregateName)}.test.ts`;
    if (changes.exists(domainTest)) {
      const test = changes.edit(domainTest);
      if (test.appendStatement(describeBody(phrase(aggregateName)), decisionTest(flavour, decision, aggregateName, event, idField))) {
        test.addImport(`@projected/testing/${flavour}`, ["given"]);
        test.addImport(moduleFrom(domainTest, aggregate.file), [decision]);
        test.addImport(moduleFrom(domainTest, eventsFile), [event]);
      }
    }
    addHttpTest(changes, serviceName(project), httpTest("command", type, serviceName(project), `{ ${idField}: "${aggregateName}-1" }`));
    return [`next: write the business rules into ${decision} (${aggregate.file}) and its tests, ${regenerate}`];
  });
}

/** `projected new query <type> --aggregate <name> | --port <Port>`. */
export function newQuery(project: Project, type: string | undefined, options: { aggregate?: string | undefined; port?: string | undefined }): CommandResult {
  return run(project, (changes) => {
    if (type === undefined) throw new Refused("name the query: projected new query <type> --aggregate <name> | --port <Port>, e.g. invoice-summary");
    refuseUnless(checkOperationType(type, "query"));
    if ((options.aggregate === undefined) === (options.port === undefined)) {
      throw new Refused("a query reads one aggregate (--aggregate <name>) or a read model behind a port (--port <Port>): name one of them");
    }
    const flavour = project.flavour;
    const contractFile = `src/application/port/driving/${type}.ts`;
    const useCaseFile = `src/application/usecase/${type}.ts`;
    const wiring = new Wiring(project, changes, compositionRoot(project.root));
    let deps: string;
    let input = "{}";
    if (options.aggregate !== undefined) {
      const aggregate = findAggregate(project.root, options.aggregate);
      if (aggregate === undefined) throw new Refused(`no aggregate ${options.aggregate} in src/domain; create it with \`projected new aggregate ${options.aggregate}\``);
      const idField = `${options.aggregate}Id`;
      const repository = plural(options.aggregate);
      changes.create(contractFile, contractModule({ flavour, kind: "query", type, idField }, sentence(type)));
      changes.create(
        useCaseFile,
        queryUseCase({ flavour, type, aggregate: { name: options.aggregate, module: moduleFrom(useCaseFile, aggregate.file), repository, idField } }),
      );
      const variable = wiring.repository(aggregate);
      deps = `{ ${variable === repository ? repository : `${repository}: ${variable}`} }`;
      input = `{ ${idField}: "${options.aggregate}-1" }`;
    } else {
      const port = options.port!;
      const portFile = findInterface(project.root, "src/application/port/driven", port);
      if (portFile === undefined) throw new Refused(`no port ${port} in src/application/port/driven; create it with \`projected new port ${port} --operations <a,b>\``);
      changes.create(contractFile, contractModule({ flavour, kind: "query", type }, sentence(type)));
      changes.create(useCaseFile, queryUseCase({ flavour, type, port: { name: port, module: moduleFrom(useCaseFile, portFile), variable: camel(port) } }));
      const variable = wiring.port(port);
      deps = `{ ${variable === camel(port) ? variable : `${camel(port)}: ${variable}`} }`;
    }
    register(changes, project, "queries", pascal(type), contractFile);
    wiring.bind("queries", `${type}@1`, `${camel(type)}(${deps})`, useCaseFile);
    addHttpTest(changes, serviceName(project), httpTest("query", type, serviceName(project), input));
    return [`next: answer the query in ${useCaseFile} and say what it returns in ${contractFile}, ${regenerate}`];
  });
}

/** `projected new port <Name> --operations <a,b> [--adapter <factory>]`. */
export function newPort(project: Project, name: string | undefined, options: { operations?: string | undefined; adapter?: string | undefined }): CommandResult {
  return run(project, (changes) => {
    if (name === undefined) throw new Refused("name the port for what the application needs: projected new port <Name> --operations <a,b>, e.g. InvoiceArchive");
    refuseUnless(checkPascal(name, "port", "InvoiceArchive"));
    const operations = (options.operations ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "");
    if (operations.length === 0) throw new Refused("name the port's operations: --operations <a,b>, e.g. --operations archive,findByCustomer");
    refuseUnless(checkCamelList(operations, "operation", "archive"));
    const factory = options.adapter ?? `document${name}`;
    refuseUnless(checkCamelList([factory], "adapter", `document${name}`));
    if (findInterface(project.root, "src/application/port", name) !== undefined) throw new Refused(`port ${name} already exists`);
    const portFile = `src/application/port/driven/${kebab(name)}.ts`;
    const adapterFile = `src/infrastructure/adapter/driven/${kebab(name)}/${kebab(factory)}.ts`;
    changes.create(portFile, portModule(project.flavour, name, operations));
    changes.create(adapterFile, adapterModule(project.flavour, name, moduleFrom(adapterFile, portFile), factory, operations));
    return [
      `next: give the operations their parameters and results in ${portFile} and implement them in ${adapterFile}; ` +
        `\`--port ${name}\` on \`projected new query\` or \`projected new event-handler\` wires it in`,
    ];
  });
}

/** `projected new event-handler <name> --on <Event,...> [--port <Port>]`. */
export function newEventHandler(project: Project, name: string | undefined, options: { on?: string | undefined; port?: string | undefined }): CommandResult {
  return run(project, (changes) => {
    if (name === undefined) throw new Refused("name the event handler: projected new event-handler <name> --on <Event,...>, e.g. invoice-reminders");
    refuseUnless(checkKebab(name, "event handler", "invoice-reminders"));
    const types = (options.on ?? "").split(",").map((t) => t.trim()).filter((t) => t !== "");
    if (types.length === 0) throw new Refused("name the events it reacts to: --on <Event,...>, e.g. --on InvoiceIssued");
    const useCaseFile = `src/application/usecase/${name}.ts`;
    const events = types.map((type) => {
      const found = findEvent(project.root, type);
      if (found === undefined) throw new Refused(`no event ${type} in src/domain`);
      return { type: found.name, module: moduleFrom(useCaseFile, found.file) };
    });
    const wiring = new Wiring(project, changes, compositionRoot(project.root));
    let deps = "";
    let port: { name: string; module: string; variable: string } | undefined;
    if (options.port !== undefined) {
      const portFile = findInterface(project.root, "src/application/port/driven", options.port);
      if (portFile === undefined) throw new Refused(`no port ${options.port} in src/application/port/driven; create it with \`projected new port ${options.port} --operations <a,b>\``);
      port = { name: options.port, module: moduleFrom(useCaseFile, portFile), variable: camel(options.port) };
      const variable = wiring.port(options.port);
      deps = `{ ${variable === port.variable ? variable : `${port.variable}: ${variable}`} }`;
    }
    changes.create(useCaseFile, eventHandlerModule({ flavour: project.flavour, name, events, ...(port === undefined ? {} : { port }) }));
    wiring.handle(`${camel(name)}(${deps})`, useCaseFile);
    return [`next: write what it does for each event in ${useCaseFile}, and test it through the app (command, then query); then \`projected docs\` and \`pnpm check\``];
  });
}

/** Inside the framework's own workspace, a new service depends on the workspace packages. */
function frameworkRange(target: string): string {
  for (let dir = dirname(target); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, "packages", "application", "package.json");
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(manifest)) {
      if ((JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === "@projected/application") return "workspace:*";
    }
  }
  const own = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")) as { version: string };
  return `^${own.version}`;
}

/** Whether `target` is inside a pnpm workspace, whose root then holds the settings pnpm reads. */
function insidePnpmWorkspace(target: string): boolean {
  for (let dir = dirname(target); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return true;
  }
  return false;
}

/** `projected new service <directory> --flavour <flavour> --aggregate <name>`. */
export function newService(cwd: string, directory: string | undefined, options: { flavour?: string | undefined; aggregate?: string | undefined }): CommandResult {
  const refuse = (message: string): CommandResult => ({ ok: false, lines: [`new: ${message} — nothing was written`] });
  if (directory === undefined) return refuse("name the service's directory: projected new service <directory> --flavour <flavour> --aggregate <name>");
  const target = resolve(cwd, directory);
  const name = basename(target);
  const nameCheck = checkKebab(name, "service", "billing");
  if (!nameCheck.ok) return refuse(`the directory's name is the service's: ${nameCheck.message}`);
  const flavour = options.flavour as Flavour | undefined;
  if (flavour === undefined || !FLAVOURS.includes(flavour)) {
    return refuse(
      `choose the flavour with --flavour ${FLAVOURS.join(" | ")}: event-sourced keeps every change as an event, state-based stores the ` +
        "current state with an outbox of events. It is fixed once the service exists.",
    );
  }
  if (options.aggregate === undefined) return refuse("name the service's first aggregate with --aggregate <name>, e.g. invoice");
  const aggregateCheck = checkAggregateName(options.aggregate);
  if (!aggregateCheck.ok) return refuse(aggregateCheck.message);
  if (existsSync(target) && readdirSync(target).length > 0) return refuse(`${directory} exists and is not empty`);

  const files = {
    ...serviceFiles({ name, flavour, framework: frameworkRange(target) }),
    ...aggregateFiles({ flavour, name: options.aggregate }, kebab(options.aggregate)),
    ...(insidePnpmWorkspace(target) ? {} : { "pnpm-workspace.yaml": PNPM_WORKSPACE }),
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFileSync(join(target, file), content);
  }
  return {
    ok: true,
    lines: [
      `new: created ${name} (${flavour}) in ${relative(cwd, target) || "."}, with the ${options.aggregate} aggregate`,
      `next: cd ${relative(cwd, target) || "."} && pnpm install && pnpm openapi && pnpm lock && pnpm catalog && pnpm check`,
      `      then set it up for coding agents (projected agents install) and grow it: projected new command <type> --aggregate ${options.aggregate} --event <Event>`,
    ],
  };
}
