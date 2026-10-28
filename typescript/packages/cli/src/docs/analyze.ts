import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * What the code says about a service's structure, found with the TypeScript type checker rather
 * than annotations: aggregates and their events, which use case writes or reads which aggregate
 * and which events its decisions create, event handlers and what they consume, driven ports and
 * the adapters implementing them, broker relays and calls to other services.
 */
export interface CodeModel {
  readonly aggregates: readonly { readonly name: string; readonly file: string; readonly events: readonly string[] }[];
  readonly events: readonly { readonly type: string; readonly version: number; readonly file: string }[];
  readonly useCases: readonly UseCase[];
  readonly eventHandlers: readonly EventHandlerUnit[];
  readonly ports: readonly { readonly name: string; readonly file: string; readonly operations: readonly string[]; readonly adapters: readonly string[] }[];
  /** `"enlist-student@2"` → the use case bound to it in the composition root. */
  readonly bindings: Readonly<Record<string, string>>;
  readonly relays: readonly string[];
}

export interface Usage {
  readonly writes: readonly string[];
  readonly reads: readonly string[];
  readonly emits: readonly string[];
  readonly ports: readonly string[];
  readonly remotes: readonly string[];
}

export interface UseCase extends Usage {
  readonly name: string;
  readonly file: string;
}

export interface EventHandlerUnit extends Usage {
  readonly name: string;
  readonly file: string;
  readonly consumes: readonly string[];
}

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|mts|tsx)$/.test(entry) && !entry.endsWith(".d.ts") ? [path] : [];
  });
}

const posix = (path: string) => path.split(sep).join("/");
const unique = (values: Iterable<string>) => [...new Set(values)].sort();
const callee = (call: ts.CallExpression) => (ts.isIdentifier(call.expression) ? call.expression.text : undefined);
const stringArg = (call: ts.CallExpression) => {
  const first = call.arguments[0];
  return first !== undefined && ts.isStringLiteralLike(first) ? first.text : undefined;
};
function property(object: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (object === undefined || !ts.isObjectLiteralExpression(object)) return undefined;
  for (const element of object.properties) {
    if (ts.isPropertyAssignment(element) && element.name.getText() === name) return element.initializer;
  }
  return undefined;
}

export function analyze(root: string): CodeModel {
  const files = sourceFiles(join(root, "src"));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const fileOf = (node: ts.Node) => posix(relative(root, node.getSourceFile().fileName));
  const inLayer = (node: ts.Node | undefined, layer: string) => node !== undefined && fileOf(node).startsWith(layer);
  const ownFiles = program.getSourceFiles().filter((file) => files.includes(file.fileName) || files.includes(posix(file.fileName)));

  const resolve = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const declarationOf = (node: ts.Node) => resolve(node)?.valueDeclaration;
  const nameOfType = (type: ts.Type) => (type.aliasSymbol ?? type.getSymbol())?.getName();
  const literal = (type: ts.Type | undefined) => (type?.isStringLiteral() ? type.value : undefined);
  const propertyType = (type: ts.Type, name: string, at: ts.Node) => {
    const symbol = type.getProperty(name);
    return symbol === undefined ? undefined : checker.getTypeOfSymbolAtLocation(symbol, at);
  };

  // Events and aggregates, from their definitions in the domain.
  const events = new Map<ts.Node, { type: string; version: number; file: string }>();
  const aggregates: Array<{ name: string; file: string; events: string[] }> = [];
  const visitAll = (visit: (node: ts.Node) => void) => (node: ts.Node) => {
    visit(node);
    ts.forEachChild(node, visitAll(visit));
  };
  for (const file of ownFiles.filter((f) => inLayer(f, "src/domain/"))) {
    visitAll((node) => {
      if (!ts.isVariableDeclaration(node) || node.initializer === undefined || !ts.isCallExpression(node.initializer)) return;
      if (callee(node.initializer) === "defineEvent") {
        const type = stringArg(node.initializer);
        const version = property(node.initializer.arguments[1], "version");
        if (type !== undefined) {
          events.set(node, { type, version: version !== undefined && ts.isNumericLiteral(version) ? Number(version.text) : 1, file: fileOf(node) });
        }
      }
    })(file);
  }
  const eventOf = (expression: ts.Expression) => {
    const declaration = declarationOf(expression);
    return declaration === undefined ? undefined : events.get(declaration)?.type;
  };
  const eventList = (expression: ts.Expression | undefined) =>
    expression !== undefined && ts.isArrayLiteralExpression(expression)
      ? expression.elements.map((element) => eventOf(element)).filter((type): type is string => type !== undefined)
      : [];
  for (const file of ownFiles.filter((f) => inLayer(f, "src/domain/"))) {
    visitAll((node) => {
      if (!ts.isCallExpression(node) || callee(node) !== "defineAggregate") return;
      const name = property(node.arguments[0], "name");
      if (name !== undefined && ts.isStringLiteralLike(name)) {
        aggregates.push({ name: name.text, file: fileOf(node), events: unique(eventList(property(node.arguments[0], "events"))) });
      }
    })(file);
  }

  // Ports: interfaces in application/port/driven.
  const portSymbols = new Map<ts.Symbol, { name: string; file: string; operations: string[]; adapters: string[] }>();
  for (const file of ownFiles.filter((f) => inLayer(f, "src/application/port/driven/"))) {
    for (const statement of file.statements) {
      if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (symbol === undefined) continue;
        // A port has operations; an exported shape with only data (a DTO the port uses) is not one.
        const operations = checker
          .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))
          .filter((p) => checker.getTypeOfSymbolAtLocation(p, statement).getCallSignatures().length > 0)
          .map((p) => p.getName());
        if (operations.length === 0) continue;
        portSymbols.set(symbol, { name: statement.name.text, file: fileOf(statement), operations: operations.sort(), adapters: [] });
      }
    }
  }
  const portOf = (type: ts.Type) => {
    const symbol = type.aliasSymbol ?? type.getSymbol();
    return symbol === undefined ? undefined : portSymbols.get(symbol);
  };

  // Adapters: exported factories in adapter/driven whose result is a port.
  for (const file of ownFiles.filter((f) => inLayer(f, "src/infrastructure/adapter/driven/"))) {
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement) && !ts.isFunctionDeclaration(statement)) continue;
      const declarations = ts.isVariableStatement(statement) ? statement.declarationList.declarations : [statement];
      for (const declaration of declarations) {
        if (declaration.name === undefined || !ts.isIdentifier(declaration.name)) continue;
        const type = checker.getTypeAtLocation(declaration.name);
        for (const signature of type.getCallSignatures()) {
          const port = portOf(signature.getReturnType());
          if (port !== undefined) port.adapters.push(declaration.name.text);
        }
      }
    }
  }

  // What a body of code does: repository writes and reads, events its decisions create, ports
  // and remote services it calls.
  const domainEvents = (declaration: ts.Node, seen: Set<ts.Node>): string[] => {
    if (seen.has(declaration)) return [];
    seen.add(declaration);
    const found: string[] = [];
    visitAll((node) => {
      if (!ts.isCallExpression(node)) return;
      const event = eventOf(node.expression);
      if (event !== undefined) found.push(event);
      const target = declarationOf(node.expression);
      if (target !== undefined && inLayer(target, "src/domain/") && !events.has(target)) found.push(...domainEvents(target, seen));
    })(declaration);
    return found;
  };
  const usageOf = (body: ts.Node): Usage => {
    const writes: string[] = [];
    const reads: string[] = [];
    const emits: string[] = [];
    const ports: string[] = [];
    const remotes: string[] = [];
    visitAll((node) => {
      if (!ts.isCallExpression(node)) return;
      const target = declarationOf(node.expression);
      if (target !== undefined && inLayer(target, "src/domain/") && !events.has(target)) emits.push(...domainEvents(target, new Set()));
      if (!ts.isPropertyAccessExpression(node.expression)) return;
      const receiver = checker.getTypeAtLocation(node.expression.expression);
      const method = node.expression.name.text;
      const kind = nameOfType(receiver);
      if (kind === "AggregateRepository") {
        const name = literal(propertyType(propertyType(receiver, "aggregate", node) ?? receiver, "name", node));
        if (name !== undefined) (method === "execute" ? writes : reads).push(name);
      } else if (kind === "RemoteService" || kind === "CommandQueue") {
        const name = literal(propertyType(propertyType(receiver, "contracts", node) ?? receiver, "name", node));
        if (name !== undefined) remotes.push(name);
      } else {
        const port = portOf(receiver);
        if (port !== undefined) ports.push(port.name);
      }
    })(body);
    return { writes: unique(writes), reads: unique(reads), emits: unique(emits), ports: unique(ports), remotes: unique(remotes) };
  };

  // Use cases and event handlers: the module-level declarations of application/usecase.
  const useCases: UseCase[] = [];
  const eventHandlers: EventHandlerUnit[] = [];
  const unitBySymbol = new Map<ts.Symbol, string>();
  for (const file of ownFiles.filter((f) => inLayer(f, "src/application/usecase/"))) {
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement) && !ts.isFunctionDeclaration(statement)) continue;
      const declarations = ts.isVariableStatement(statement) ? statement.declarationList.declarations : [statement];
      for (const declaration of declarations) {
        if (declaration.name === undefined || !ts.isIdentifier(declaration.name)) continue;
        const symbol = checker.getSymbolAtLocation(declaration.name);
        let handler: ts.CallExpression | undefined;
        visitAll((node) => {
          if (handler === undefined && ts.isCallExpression(node) && callee(node) === "defineEventHandler") handler = node;
        })(declaration);
        const usage = usageOf(declaration);
        const name = handler === undefined ? undefined : property(handler.arguments[0], "name");
        if (handler !== undefined && name !== undefined && ts.isStringLiteralLike(name)) {
          eventHandlers.push({ name: name.text, file: fileOf(declaration), consumes: unique(eventList(property(handler.arguments[0], "events"))), ...usage });
        } else {
          useCases.push({ name: declaration.name.text, file: fileOf(declaration), ...usage });
          if (symbol !== undefined) unitBySymbol.set(symbol, declaration.name.text);
        }
      }
    }
  }

  // The composition root: which use case serves which contract, and which events are relayed.
  const bindings: Record<string, string> = {};
  const relays: string[] = [];
  for (const file of ownFiles.filter((f) => inLayer(f, "src/infrastructure/config/"))) {
    visitAll((node) => {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.name) && /^[a-z][a-z0-9-]*@\d+$/.test(node.name.text)) {
        const bound = ts.isCallExpression(node.initializer) ? node.initializer.expression : node.initializer;
        const symbol = resolve(bound);
        const unit = symbol === undefined ? undefined : unitBySymbol.get(symbol);
        if (unit !== undefined) bindings[node.name.text] = unit;
      }
      if (ts.isCallExpression(node) && callee(node) === "eventRelay") {
        const topic = property(node.arguments[1], "topic");
        if (topic !== undefined && ts.isStringLiteralLike(topic)) relays.push(topic.text);
      }
    })(file);
  }

  return {
    aggregates: aggregates.sort((a, b) => a.name.localeCompare(b.name)),
    events: [...events.values()].sort((a, b) => a.type.localeCompare(b.type)),
    useCases: useCases.sort((a, b) => a.name.localeCompare(b.name)),
    eventHandlers: eventHandlers.sort((a, b) => a.name.localeCompare(b.name)),
    ports: [...portSymbols.values()].map((port) => ({ ...port, adapters: unique(port.adapters) })).sort((a, b) => a.name.localeCompare(b.name)),
    bindings,
    relays: unique(relays),
  };
}
