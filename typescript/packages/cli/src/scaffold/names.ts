import { CRUD_VERBS } from "@projected/architecture";

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CAMEL = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL = /^[A-Z][a-zA-Z0-9]*$/;

/** Words of a kebab-case, camelCase or PascalCase name, lower-cased. */
export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter((word) => word !== "");
}

export const kebab = (name: string) => wordsOf(name).join("-");
export const pascal = (name: string) => wordsOf(name).map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
export const camel = (name: string) => {
  const p = pascal(name);
  return p[0]!.toLowerCase() + p.slice(1);
};
/** "Issue invoice" from "issue-invoice": the summary a generated contract starts with. */
export const sentence = (name: string) => {
  const text = wordsOf(name).join(" ");
  return text[0]!.toUpperCase() + text.slice(1);
};

/** A plural for repository and collection names: invoice → invoices, policy → policies. */
export function plural(name: string): string {
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(name)) return `${name}es`;
  return `${name}s`;
}

/** A name refused, with the reason written for whoever typed it. */
export type NameCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

const ok: NameCheck = { ok: true };

export function checkOperationType(type: string, kind: "command" | "query"): NameCheck {
  if (!KEBAB.test(type)) return { ok: false, message: `"${type}" must be kebab-case, e.g. ${kind === "command" ? "issue-invoice" : "invoice-summary"}` };
  const verb = type.split("-")[0]!;
  if (CRUD_VERBS.includes(verb)) {
    return {
      ok: false,
      message:
        `"${type}" names a data change (${verb}), not a business operation. Name what the user decided to do, in the ` +
        "domain's words: enlist-student rather than create-student, enlisted-students-on-joining-date rather than get-students.",
    };
  }
  return ok;
}

export function checkAggregateName(name: string): NameCheck {
  return CAMEL.test(name) ? ok : { ok: false, message: `aggregate "${name}" must be camelCase with no dashes, e.g. invoice or lineItem` };
}

export function checkPascal(name: string, what: string, example: string): NameCheck {
  return PASCAL.test(name) ? ok : { ok: false, message: `${what} "${name}" must be PascalCase, e.g. ${example}` };
}

export function checkKebab(name: string, what: string, example: string): NameCheck {
  return KEBAB.test(name) ? ok : { ok: false, message: `${what} "${name}" must be kebab-case, e.g. ${example}` };
}

export function checkCamelList(names: readonly string[], what: string, example: string): NameCheck {
  const bad = names.find((name) => !CAMEL.test(name));
  return bad === undefined ? ok : { ok: false, message: `${what} "${bad}" must be camelCase, e.g. ${example}` };
}

const RESERVED = new Set(
  ("break case catch class const continue debugger default delete do else enum export extends false finally for function if " +
    "import in instanceof new null return super switch this throw true try typeof var void while with yield let static " +
    "implements interface package private protected public await").split(" "),
);

/**
 * The decision function for a command: its words without the aggregate's —
 * withdraw-student on student → withdraw, report-student-lastname-change → reportLastnameChange,
 * and void-invoice → decideVoidInvoice, as `void` is a keyword (and `voidInvoice` is the use case).
 */
export function decisionName(type: string, aggregate: string): string {
  const words = type.split("-");
  const own = wordsOf(aggregate);
  const at = words.findIndex((_, i) => own.every((word, j) => words[i + j] === word));
  const rest = at === -1 ? words : [...words.slice(0, at), ...words.slice(at + own.length)];
  const name = rest.length === 0 ? "" : camel(rest.join("-"));
  return name === "" || RESERVED.has(name) ? `decide${pascal(type)}` : name;
}
