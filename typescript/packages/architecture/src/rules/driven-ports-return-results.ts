import type { Rule } from "eslint";

/** The few TypeScript AST shapes this rule reads. */
interface TypeNode {
  readonly type: string;
  readonly parent?: TypeNode & { readonly returnType?: unknown };
  readonly typeName?: { readonly type: string; readonly name?: string };
  readonly typeArguments?: { readonly params: readonly TypeNode[] };
}

const FUNCTION_SIGNATURES = new Set(["TSMethodSignature", "TSFunctionType", "TSCallSignatureDeclaration", "TSDeclareFunction"]);
const isNamed = (node: TypeNode | undefined, ...names: string[]) =>
  node?.type === "TSTypeReference" && node.typeName?.type === "Identifier" && names.includes(node.typeName.name ?? "");

/**
 * Every asynchronous operation of a driven port returns a Result, so a use case composes outside
 * calls with `yield*` and never needs `try`. Synchronous ports that cannot fail (`Clock`) are fine.
 */
export const drivenPortsReturnResults: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Asynchronous driven port operations return Promise<Result<...>>." },
    schema: [],
    messages: {
      notAResult:
        "Driven ports return Results: declare Promise<Result<T, DependencyUnavailable | DependencyFailure>> " +
        "(plus any business error the port can report) instead of Promise<T>. Adapters then turn every outside " +
        "failure into a value, and use cases compose calls with yield* instead of try.",
    },
  },
  create: (context) => ({
    TSTypeReference: (estree: unknown) => {
      const node = estree as TypeNode;
      if (!isNamed(node, "Promise", "PromiseLike")) return;
      const annotation = node.parent;
      const signature = annotation?.parent;
      if (annotation?.type !== "TSTypeAnnotation" || signature === undefined || !FUNCTION_SIGNATURES.has(signature.type)) return;
      if (signature.returnType !== annotation) return;
      if (isNamed(node.typeArguments?.params[0], "Result")) return;
      context.report({ node: estree as Rule.Node, messageId: "notAResult" });
    },
  }),
};
