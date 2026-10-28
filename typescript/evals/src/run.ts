import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { HARNESSES, type Harness } from "@projected/cli";
import { AGENT_COMMANDS, evaluate, loadTasks, typescriptRoot, type Result } from "./evals.js";

const USAGE = `pnpm evals [--harness claude-code|codex|cursor] [--agent "<command>"] [--task <name>] [--timeout-minutes <n>]

Runs every task (or one) on fresh copies of the school examples with a coding agent, and grades
what it leaves: the gate (compile, tests, projected check) and the task's own expectations.
--agent replaces the harness's command; the prompt is in $PROJECTED_EVAL_PROMPT. Needs the
harness installed and signed in. Copies and logs stay in evals/.runs/.`;

const { values } = parseArgs({
  options: {
    harness: { type: "string", default: "claude-code" },
    agent: { type: "string" },
    task: { type: "string" },
    "timeout-minutes": { type: "string", default: "20" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const harness = values.harness as Harness;
if (!HARNESSES.includes(harness)) {
  console.error(`Unknown harness ${harness}: ${HARNESSES.join(", ")}`);
  process.exit(2);
}
const tasks = loadTasks(values.task);
if (tasks.length === 0) {
  console.error(`No task ${values.task ?? ""} in evals/tasks`);
  process.exit(2);
}

const run = join(typescriptRoot, "evals", ".runs", new Date().toISOString().replace(/[:.]/g, "-"));
const results: Result[] = [];
for (const task of tasks) {
  for (const flavour of task.flavours) {
    console.log(`▶ ${task.name} (${flavour}) with ${harness}…`);
    const result = await evaluate(task, flavour, {
      dir: join(run, `${task.name}-${flavour}`),
      harness,
      command: values.agent ?? AGENT_COMMANDS[harness],
      timeoutMs: Number(values["timeout-minutes"]) * 60_000,
    });
    results.push(result);
    for (const check of result.checks) console.log(`  ${check.passed ? "✓" : "✗"} ${check.name}${check.detail === undefined || check.passed ? "" : `\n${check.detail.replace(/^/gm, "      ")}`}`);
    console.log(`  ${result.passed ? "passed" : "failed"} in ${result.agent.seconds}s (agent exit ${result.agent.exitCode}) — ${result.dir}`);
  }
}
mkdirSync(run, { recursive: true });
writeFileSync(join(run, "report.json"), `${JSON.stringify(results.map(({ agent, ...rest }) => ({ ...rest, seconds: agent.seconds, agentExitCode: agent.exitCode })), null, 2)}\n`);
const passed = results.filter((result) => result.passed).length;
console.log(`\n${passed}/${results.length} passed — report in ${join(run, "report.json")}`);
process.exitCode = passed === results.length ? 0 : 1;
