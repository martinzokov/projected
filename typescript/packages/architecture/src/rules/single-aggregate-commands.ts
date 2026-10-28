import type { Rule } from "eslint";
import ts from "typescript";

interface Node {
  readonly type: string;
  readonly parent?: Node;
  readonly callee?: Node & { readonly object?: Node; readonly property?: { readonly name?: string } };
  readonly arguments?: readonly Node[];
}

interface ParserServices {
  readonly program?: ts.Program;
  readonly esTreeNodeToTSNodeMap?: { get(node: unknown): ts.Node };
}

const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const ITERATING = new Set(["map", "flatMap", "forEach", "reduce", "filter", "some", "every"]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

/** The module-level statement a node belongs to: one handler (or one handler factory). */
function topLevel(node: Node): Node {
  let current = node;
  while (current.parent !== undefined && current.parent.type !== "Program") current = current.parent;
  return current;
}

/** Inside a loop, or a function passed to an array iteration method, below its handler. */
function repeated(node: Node, stop: Node): boolean {
  for (let current = node.parent; current !== undefined && current !== stop; current = current.parent) {
    if (LOOPS.has(current.type)) return true;
    const call = current.parent;
    if (
      FUNCTIONS.has(current.type) &&
      call?.type === "CallExpression" &&
      call.arguments?.includes(current) === true &&
      ITERATING.has(call.callee?.property?.name ?? "")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * One command changes one aggregate: the aggregate is the consistency boundary, and a handler
 * that writes two of them has no transaction holding them together. Rules spanning several
 * aggregates are policies reacting to events, or a sign the boundary is in the wrong place.
 * Handlers that deliberately write several (a saga step, a migration) are listed under `allow`.
 */
export const singleAggregateCommands: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: { description: "A use case writes through at most one aggregate repository call." },
    schema: [],
    messages: {
      several:
        "This handler writes more than one aggregate ({{count}} repository execute calls). One command changes one " +
        "aggregate: move the other change into a policy (an event handler reacting to this one's events), or merge " +
        'the aggregates if the rule must hold atomically. If this is deliberate, list the file under "allow" for ' +
        '"single-aggregate-commands" in projected.json.',
      loop:
        "This handler writes aggregates in a loop. One command changes one aggregate: send one command per aggregate " +
        '(a CommandQueue does this asynchronously), or list the file under "allow" for "single-aggregate-commands".',
      noTypes: "This rule needs type information: lint src/application with typescript-eslint's projectService (projected check does).",
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
    const isRepository = (node: Node) => {
      const type = checker.getTypeAtLocation(map.get(node));
      return ((type.aliasSymbol ?? type.getSymbol())?.getName() ?? "") === "AggregateRepository";
    };
    const writes = new Map<Node, Node[]>();
    return {
      CallExpression: (estree) => {
        const node = estree as unknown as Node;
        const callee = node.callee;
        if (callee?.type !== "MemberExpression" || callee.property?.name !== "execute" || callee.object === undefined) return;
        if (!isRepository(callee.object)) return;
        const handler = topLevel(node);
        if (repeated(node, handler)) {
          context.report({ node: estree, messageId: "loop" });
          return;
        }
        writes.set(handler, [...(writes.get(handler) ?? []), node]);
      },
      "Program:exit": () => {
        for (const calls of writes.values()) {
          if (calls.length > 1) {
            context.report({ node: calls[1] as unknown as Rule.Node, messageId: "several", data: { count: String(calls.length) } });
          }
        }
      },
    };
  },
};
