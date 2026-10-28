import type { Rule } from "eslint";
import ts from "typescript";

interface Node {
  readonly type: string;
  readonly parent?: Node;
  readonly argument?: Node;
  readonly arguments?: readonly Node[];
  readonly callee?: Node & { readonly name?: string; readonly property?: { readonly name?: string } };
  readonly key?: { readonly name?: string };
  readonly value?: Node;
}

interface ParserServices {
  readonly program?: ts.Program;
  readonly esTreeNodeToTSNodeMap?: { get(node: unknown): ts.Node };
}

const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

/** `fromDependency("x", async () => ...)` or `Result.tryPromise({ try: async () => ... })`. */
function insideFailureBoundary(node: Node): boolean {
  let fn = node.parent;
  while (fn !== undefined && !FUNCTIONS.has(fn.type)) fn = fn.parent;
  const holder = fn?.parent;
  if (holder?.type === "CallExpression" && holder.callee?.type === "Identifier" && holder.callee.name === "fromDependency") {
    return holder.arguments?.includes(fn as Node) ?? false;
  }
  if (holder?.type === "Property" && holder.key?.name === "try" && holder.value === fn) {
    const call = holder.parent?.parent;
    return call?.type === "CallExpression" && call.callee?.property?.name === "tryPromise";
  }
  return false;
}

const parts = (type: ts.Type): readonly ts.Type[] => (type.isUnion() ? type.types : [type]);
const isThenable = (type: ts.Type) => parts(type).some((part) => part.getProperty("then") !== undefined);
const isResult = (type: ts.Type) =>
  parts(type).every((part) => ["Ok", "Err"].includes((part.aliasSymbol ?? part.getSymbol())?.getName() ?? ""));

/** A Result, or a tuple or array of Results (`await Promise.all([...])`). */
function holdsResults(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (isResult(type)) return true;
  if (checker.isTupleType(type) || checker.isArrayType(type)) {
    const elements = checker.getTypeArguments(type as ts.TypeReference);
    return elements.length > 0 && elements.every((element) => isResult(element));
  }
  return false;
}

/**
 * A driven adapter is where outside failures become values. Awaiting a promise that is not a
 * Result means a rejection there escapes the adapter as an exception — a defect at runtime —
 * unless it happens inside `fromDependency` (or `Result.tryPromise`), which turns it into one.
 */
export const drivenAdaptersReturnResults: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Driven adapters await only Results; anything that can reject goes through fromDependency." },
    schema: [],
    messages: {
      rejectable:
        "This awaits a promise that is not a Result, so a rejection escapes the adapter as an exception. Wrap the " +
        'call: fromDependency("<dependency name>", () => ...) from @projected/application returns a Result with ' +
        "DependencyUnavailable or DependencyFailure instead.",
      noTypes:
        "This rule needs type information: lint src/infrastructure with typescript-eslint's projectService " +
        "(projected check does).",
    },
  },
  create: (context) => {
    const services = context.sourceCode.parserServices as ParserServices | undefined;
    const program = services?.program;
    const map = services?.esTreeNodeToTSNodeMap;
    if (program === undefined || map === undefined) {
      return { Program: (node) => context.report({ node, messageId: "noTypes" }) };
    }
    const checker = program.getTypeChecker();
    return {
      AwaitExpression: (estree) => {
        const node = estree as unknown as Node;
        if (node.argument === undefined || insideFailureBoundary(node)) return;
        const type = checker.getTypeAtLocation(map.get(node.argument));
        if (!isThenable(type)) return;
        const awaited = checker.getAwaitedType(type);
        if (awaited !== undefined && holdsResults(checker, awaited)) return;
        context.report({ node: estree, messageId: "rejectable" });
      },
    };
  },
};
