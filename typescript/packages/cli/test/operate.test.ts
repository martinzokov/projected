import { describe, expect, it } from "vitest";
import { OPERATE, Result, createApplication, defineContracts, defineOperatorTask, z, type Authenticator } from "@projected/application";
import { httpHandler } from "@projected/http";
import { operate } from "@projected/cli";

/** A principal with `projected:operate` for `Bearer ops`, anonymous otherwise. */
const operators: Authenticator = {
  authenticate: async ({ headers }) =>
    Result.ok(headers["authorization"] === "Bearer ops" ? { id: "u-ops", kind: "user", permissions: [OPERATE], claims: {} } : undefined),
};

function service() {
  const reindex = defineOperatorTask({
    name: "reindex-search",
    description: "Send every ticket to the search index again.",
    input: z.object({ since: z.iso.date().optional(), scope: z.enum(["open", "all"]) }),
    run: ({ scope }) => Result.ok({ queued: scope === "all" ? 12 : 3 }),
  });
  const app = createApplication(defineContracts({ name: "tickets", access: "public" }), {
    ids: { next: () => "id" },
    operatorTasks: [reindex],
  });
  const handler = httpHandler(app, { authenticator: operators });
  return { fetch: (url: string, init: RequestInit) => handler(new Request(url, init)), url: "http://tickets.test" };
}

describe("projected operate", () => {
  it("lists the service's tasks with the input each takes, when no task is named", async () => {
    const result = await operate(undefined, { ...service(), token: "ops" });

    expect(result.ok).toBe(true);
    expect(result.lines.find((line) => line.startsWith("reindex-search"))).toBe(
      'reindex-search  { since?: string, scope: "open" | "all" }  Send every ticket to the search index again.',
    );
  });

  it("runs a task with its input and prints the outcome", async () => {
    const result = await operate("reindex-search", { ...service(), token: "ops", input: '{"scope":"all"}' });

    expect(result).toEqual({ ok: true, lines: ["{", '  "queued": 12', "}"] });
  });

  it("says what to do when the call is refused", async () => {
    const anonymous = await operate("backlog", { ...service() });
    const invalid = await operate("reindex-search", { ...service(), token: "ops", input: '{"scope":"some"}' });
    const malformed = await operate("reindex-search", { ...service(), token: "ops", input: "{scope:all}" });

    expect(anonymous.ok).toBe(false);
    expect(anonymous.lines[0]).toMatch(/^operate: backlog: 401 Authentication required: .* — pass a token with --token or PROJECTED_OPERATOR_TOKEN$/);
    expect(invalid.lines[0]).toMatch(/^operate: reindex-search: 400 Invalid input/);
    expect(malformed.lines[0]).toBe(`operate: --input must be JSON, e.g. --input '{"handler":"student-directory"}'`);
  });
});
