import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluate, loadTasks, typescriptRoot, type EvalTask } from "../src/evals.js";

/**
 * The grading, proven with scripted agents instead of real ones: one that does nothing, one that
 * does the job with the generators, and one that does it but switches a test off.
 */

const scratch = join(typescriptRoot, "evals", ".runs", `test-${process.pid}`);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const task = loadTasks("suspend-student")[0] as EvalTask;
const projected = "npx --no-install projected";
const doesTheJob = [
  `${projected} new command suspend-student --aggregate student --event StudentSuspended`,
  `${projected} openapi`,
  `${projected} contracts --update`,
  `${projected} docs`,
].join(" && ");
let runs = 0;
const run = (command: string) =>
  evaluate(task, "event-sourced", { dir: join(scratch, `${++runs}`), harness: "claude-code", command, timeoutMs: 120_000 });
const verdicts = (checks: ReadonlyArray<{ name: string; passed: boolean }>) => Object.fromEntries(checks.map((check) => [check.name, check.passed]));

describe("grading an agent's work", () => {
  it("fails an agent that leaves the school as it was, though the gate passes", async () => {
    const result = await run("true");

    expect(result.passed).toBe(false);
    expect(verdicts(result.checks)).toEqual({
      gate: true,
      "operation suspend-student@1": false,
      "event StudentSuspended": false,
      "new tests": false,
      "no check switched off": true,
    });
  }, 240_000);

  it("passes an agent that adds, tests, wires and locks the operation", async () => {
    const result = await run(doesTheJob);

    expect(verdicts(result.checks)).toEqual({
      gate: true,
      "operation suspend-student@1": true,
      "event StudentSuspended": true,
      "new tests": true,
      "no check switched off": true,
    });
    expect(result.passed).toBe(true);
  }, 240_000);

  it("fails an agent that gets green by switching a test off", async () => {
    const result = await run(`${doesTheJob} && sed -i 's/^  it("enlists a student and finds them/  it.skip("enlists a student and finds them/' test/http.test.ts`);

    expect(verdicts(result.checks)).toMatchObject({ gate: true, "no check switched off": false });
    expect(result.passed).toBe(false);
  }, 240_000);
});
