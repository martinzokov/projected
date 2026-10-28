import type { Rule } from "eslint";

interface Node {
  readonly type: string;
  readonly name?: string;
  readonly value?: unknown;
  readonly callee?: Node;
  readonly arguments?: readonly Node[];
  readonly properties?: readonly Node[];
  readonly key?: Node;
}

/** Verbs that describe a data change rather than a business decision. */
export const CRUD_VERBS = ["create", "update", "delete", "set", "patch", "get", "put", "insert", "upsert", "modify", "save"];

/**
 * Commands and queries are named for what the business does — `enlist-student`, not
 * `create-student` — so that every operation states an intent and two business reasons for the
 * same data change stay two operations.
 */
export const businessOperationNames: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: { description: "Operation types name a business intent, never a CRUD verb." },
    schema: [],
    messages: {
      crud:
        '"{{type}}" names a data change ({{verb}}), not a business operation. Name what the user decided to do, in ' +
        "the domain's words: enlist-student rather than create-student, report-student-lastname-change rather than " +
        "update-student, enlisted-students-on-joining-date rather than get-students.",
    },
  },
  create: (context) => ({
    CallExpression: (estree) => {
      const node = estree as unknown as Node;
      if (node.callee?.type !== "Identifier" || !["defineCommand", "defineQuery"].includes(node.callee.name ?? "")) return;
      const options = node.arguments?.[0];
      const type = options?.properties?.find((p) => p.key?.name === "type")?.value as Node | undefined;
      if (type?.type !== "Literal" || typeof type.value !== "string") return;
      const verb = type.value.split("-")[0] ?? "";
      if (CRUD_VERBS.includes(verb)) context.report({ node: type as unknown as Rule.Node, messageId: "crud", data: { type: type.value, verb } });
    },
  }),
};
