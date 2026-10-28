import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

/**
 * A TypeScript file changed in place by the generators: an import added, an element appended to
 * a list, a property to an object, a statement to a block. Every change re-parses the file, so
 * each finds the code as the previous one left it, and keeps the file's own layout — one line
 * stays one line, a list written one item per line grows by a line.
 */
export class Source {
  readonly path: string;
  private text: string;

  private constructor(path: string, text: string) {
    this.path = path;
    this.text = text;
  }

  static read(path: string): Source {
    return new Source(path, readFileSync(path, "utf8"));
  }

  static of(path: string, text: string): Source {
    return new Source(path, text);
  }

  get content(): string {
    return this.text;
  }

  save(): void {
    writeFileSync(this.path, this.text);
  }

  parse(): ts.SourceFile {
    return ts.createSourceFile(this.path, this.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  }

  private insert(position: number, code: string): void {
    this.text = this.text.slice(0, position) + code + this.text.slice(position);
  }

  private replace(start: number, end: number, code: string): void {
    this.text = this.text.slice(0, start) + code + this.text.slice(end);
  }

  private indentAt(position: number): string {
    const lineStart = this.text.lastIndexOf("\n", position - 1) + 1;
    return /^[ \t]*/.exec(this.text.slice(lineStart))![0];
  }

  private multiline(node: ts.Node): boolean {
    const source = node.getSourceFile();
    return source.getLineAndCharacterOfPosition(node.getStart()).line !== source.getLineAndCharacterOfPosition(node.getEnd()).line;
  }

  /** Import `values` and `types` from `from`, merging into an existing import of that module. */
  addImport(from: string, values: readonly string[], types: readonly string[] = []): this {
    const source = this.parse();
    const existing = source.statements.find(
      (statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === from &&
        statement.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.name === undefined,
    );
    const wanted = new Map<string, boolean>(); // name → type-only
    if (existing !== undefined) {
      const clause = existing.importClause!;
      for (const element of (clause.namedBindings as ts.NamedImports).elements) {
        wanted.set(element.name.text, clause.isTypeOnly || element.isTypeOnly);
      }
    }
    for (const name of types) if (!wanted.has(name)) wanted.set(name, true);
    for (const name of values) wanted.set(name, false);

    const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const valueNames = [...wanted].filter(([, type]) => !type).map(([name]) => name).sort(byName);
    const typeNames = [...wanted].filter(([, type]) => type).map(([name]) => name).sort(byName);
    const typeOnly = valueNames.length === 0;
    const specifiers = typeOnly ? typeNames : [...valueNames, ...typeNames.map((name) => `type ${name}`)];
    const keyword = typeOnly ? "import type" : "import";

    if (existing === undefined) {
      const line = `${keyword} { ${specifiers.join(", ")} } from "${from}";\n`;
      const imports = source.statements.filter(ts.isImportDeclaration);
      const relative = (node: ts.ImportDeclaration) => (node.moduleSpecifier as ts.StringLiteral).text.startsWith(".");
      const after = from.startsWith(".") ? imports.at(-1) : imports.filter((node) => !relative(node)).at(-1);
      if (after !== undefined) this.insert(this.text.indexOf("\n", after.getEnd()) + 1, line);
      else if (imports[0] !== undefined) this.insert(imports[0].getStart(), line);
      else this.insert(0, `${line}\n`);
      return this;
    }
    const bindings = existing.importClause!.namedBindings as ts.NamedImports;
    const list = this.multiline(bindings)
      ? `{\n${specifiers.map((specifier) => `${this.indentAt(bindings.elements[0]!.getStart())}${specifier},`).join("\n")}\n}`
      : `{ ${specifiers.join(", ")} }`;
    this.replace(existing.getStart(), existing.getEnd(), `${keyword} ${list} from "${from}";`);
    return this;
  }

  /** Append `element` to an array literal — before a trailing spread, so `...rest` stays last. */
  appendElement(find: (source: ts.SourceFile) => ts.ArrayLiteralExpression | undefined, element: string): boolean {
    const array = find(this.parse());
    if (array === undefined) return false;
    const elements = array.elements;
    if (elements.length === 0) {
      this.replace(array.getStart(), array.getEnd(), `[${element}]`);
      return true;
    }
    const multiline = this.multiline(array);
    const spread = elements.find(ts.isSpreadElement);
    if (spread !== undefined) {
      this.insert(spread.getStart(), multiline ? `${element},\n${this.indentAt(spread.getStart())}` : `${element}, `);
      return true;
    }
    this.appendAfterLast(elements, multiline, element);
    return true;
  }

  /** Add `property` (`key: value`) to an object literal; an empty one opens onto lines of its own. */
  addProperty(find: (source: ts.SourceFile) => ts.ObjectLiteralExpression | undefined, property: string): boolean {
    const object = find(this.parse());
    if (object === undefined) return false;
    const properties = object.properties;
    if (properties.length === 0) {
      const indent = this.indentAt(object.getStart());
      this.replace(object.getStart(), object.getEnd(), `{\n${indent}  ${property},\n${indent}}`);
      return true;
    }
    this.appendAfterLast(properties, this.multiline(object), property);
    return true;
  }

  private appendAfterLast(elements: ts.NodeArray<ts.Node>, multiline: boolean, code: string): void {
    const last = elements.at(-1)!;
    if (!multiline) {
      this.insert(last.getEnd(), `, ${code}`);
      return;
    }
    const indent = this.indentAt(last.getStart());
    if (elements.hasTrailingComma) {
      const comma = this.text.indexOf(",", last.getEnd());
      this.insert(comma + 1, `\n${indent}${code},`);
    } else {
      this.insert(last.getEnd(), `,\n${indent}${code}`);
    }
  }

  /** Add `name` to an object destructuring pattern, `const { a, b } = …`. */
  addBinding(find: (source: ts.SourceFile) => ts.ObjectBindingPattern | undefined, name: string): boolean {
    const pattern = find(this.parse());
    if (pattern === undefined) return false;
    if (pattern.elements.some((element) => ts.isIdentifier(element.name) && element.name.text === name)) return true;
    if (pattern.elements.length === 0) this.replace(pattern.getStart(), pattern.getEnd(), `{ ${name} }`);
    else this.appendAfterLast(pattern.elements, this.multiline(pattern), name);
    return true;
  }

  /** Insert `code` as a statement just before the statement `find` returns, at its indentation. */
  insertBefore(find: (source: ts.SourceFile) => ts.Node | undefined, code: string): boolean {
    const node = find(this.parse());
    if (node === undefined) return false;
    const indent = this.indentAt(node.getStart());
    this.insert(node.getStart(), `${code.split("\n").join(`\n${indent}`)}\n${indent}`);
    return true;
  }

  /** Append `code` as the last statement of a block, one level in from its braces. */
  appendStatement(find: (source: ts.SourceFile) => ts.Block | undefined, code: string): boolean {
    const block = find(this.parse());
    if (block === undefined) return false;
    const closing = block.getEnd() - 1;
    const outer = this.indentAt(closing);
    const inner = block.statements[0] === undefined ? `${outer}  ` : this.indentAt(block.statements[0].getStart());
    const lines = code.split("\n").map((line) => (line === "" ? "" : `${inner}${line}`));
    const before = this.text.slice(0, closing).replace(/[ \t]*$/, "");
    const separator = block.statements.length === 0 ? "" : "\n";
    this.text = `${before}${separator}${lines.join("\n")}\n${outer}${this.text.slice(closing)}`;
    return true;
  }

  /** Append `code` at the end of the file, after a blank line. */
  append(code: string): this {
    this.text = `${this.text.replace(/\s*$/, "")}\n\n${code.replace(/\s*$/, "")}\n`;
    return this;
  }
}

/** The first call to `name(...)` anywhere in the file. */
export function findCall(node: ts.Node, name: string): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  const visit = (child: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === name) {
      found = child;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** The value of property `name` in an object literal. */
export function propertyOf(node: ts.Node | undefined, name: string): ts.Expression | undefined {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name) {
      return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
  }
  return undefined;
}

/** The value at `path` (`a` or `a.b`) in argument `argument` of the first `call(...)`. */
export function valueAt(source: ts.SourceFile, call: string, path: string, argument = 0): ts.Expression | undefined {
  let value: ts.Node | undefined = findCall(source, call)?.arguments[argument];
  for (const name of path.split(".")) value = propertyOf(value, name);
  return value as ts.Expression | undefined;
}

/** The array literal at `path` in the first `call(...)`'s options. */
export const arrayIn =
  (call: string, path: string, argument = 0) =>
  (source: ts.SourceFile): ts.ArrayLiteralExpression | undefined => {
    const value = valueAt(source, call, path, argument);
    return value !== undefined && ts.isArrayLiteralExpression(value) ? value : undefined;
  };

/** The object literal at `path` in the first `call(...)`'s options. */
export const objectIn =
  (call: string, path: string, argument = 0) =>
  (source: ts.SourceFile): ts.ObjectLiteralExpression | undefined => {
    const value = valueAt(source, call, path, argument);
    return value !== undefined && ts.isObjectLiteralExpression(value) ? value : undefined;
  };

/** The body of the exported function (declaration or arrow) called `name`. */
export function functionBody(source: ts.SourceFile, name: string): ts.Block | undefined {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.body;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer !== undefined) {
          const init = declaration.initializer;
          if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isBlock(init.body)) return init.body;
        }
      }
    }
  }
  return undefined;
}

/** The callback body of `describe("title", () => { ... })`. */
export const describeBody =
  (title: string) =>
  (source: ts.SourceFile): ts.Block | undefined => {
    let found: ts.Block | undefined;
    const visit = (node: ts.Node): void => {
      if (found !== undefined) return;
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "describe" &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        node.arguments[0].text === title
      ) {
        const callback = node.arguments[1];
        if (callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body)) {
          found = callback.body;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };

/** Names a module exports with `export const|function|class|interface|type`. */
export function exportedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
}
