import type { Rule } from "eslint";

interface Node {
  readonly type: string;
  readonly name?: string;
  readonly value?: unknown;
  readonly callee?: Node;
  readonly arguments?: readonly Node[];
}

/** Irregular past tenses and participles that do not end in -ed. */
const IRREGULAR = new Set(
  (
    "arisen awoke awoken been bore borne beaten became become began begun bent bet bid bound bit bitten bled blew blown " +
    "broke broken bred brought built burnt burst bought cast caught chose chosen clung came cost crept cut dealt dug did " +
    "done drew drawn dreamt drank drunk drove driven ate eaten fell fallen fed felt fought found fled flung flew flown " +
    "forbade forbidden forgot forgotten forgave forgiven froze frozen got gotten gave given went gone ground grew grown " +
    "hung had heard hid hidden hit held hurt kept knelt knew known laid led leapt learnt left lent let lay lain lit lost " +
    "made meant met paid proven put quit read rid rode ridden rang rung rose risen ran run said saw seen sought sold sent " +
    "set shook shaken shed shone shot shown shut sang sung sank sunk sat slept slid split spoke spoken sped spent spilt " +
    "spun spread sprang sprung stood stole stolen stuck stung struck strung swore sworn swept swam swum swung took taken " +
    "taught tore torn told thought threw thrown understood undertook undertaken undid undone upset woke woken wore worn " +
    "wove woven wept won wound withdrew withdrawn withheld withstood wrung wrote written overdrawn overpaid overrode " +
    "overridden overtook overtaken rebuilt redone remade reread resent reset resold retold rewritten"
  ).split(" "),
);

export const words = (pascal: string) => pascal.match(/[A-Z][a-z0-9]*|[0-9]+/g) ?? [pascal];
export const isPastTense = (word: string) => {
  const lower = word.toLowerCase();
  return (lower.endsWith("ed") && lower.length > 3) || IRREGULAR.has(lower);
};

/**
 * Events are facts: something that already happened, named in the past tense. A name with no
 * past tense in it (`StudentCreate`, `OrderShipping`) usually describes a request or a process,
 * which belongs in a command. A heuristic, so it defaults to a warning.
 */
export const pastTenseEvents: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: { description: "Event types are facts, named in the past tense." },
    schema: [],
    messages: {
      notPast:
        '"{{type}}" has no past tense in it. Events are facts that already happened: StudentEnlisted, OrderShipped, ' +
        "StudentLeftSchool. If this is a request, it is a command; if it is a fact, say what happened.",
    },
  },
  create: (context) => ({
    CallExpression: (estree) => {
      const node = estree as unknown as Node;
      if (node.callee?.type !== "Identifier" || node.callee.name !== "defineEvent") return;
      const type = node.arguments?.[0];
      if (type?.type !== "Literal" || typeof type.value !== "string") return;
      if (!words(type.value).some(isPastTense)) {
        context.report({ node: type as unknown as Rule.Node, messageId: "notPast", data: { type: type.value } });
      }
    },
  }),
};
