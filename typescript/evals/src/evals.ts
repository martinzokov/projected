import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guard, installAgents, loadProject, type Harness } from "@projected/cli";

/**
 * Evals: does an agent, given a business requirement and nothing else, end with a change that
 * passes the gate and does what was asked — and does it do so the way the skills say? Each task
 * runs on a fresh copy of a school example, in a git repository of its own, with the harness set
 * up by `projected agents install`.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const typescriptRoot = join(here, "..", "..");
export const tasksDir = join(here, "..", "tasks");
const projectedBin = join(typescriptRoot, "packages", "cli", "bin", "projected.js");

export type Flavour = "event-sourced" | "state-based";

export interface EvalTask {
  readonly name: string;
  /** The requirement, as a product owner would put it: no file names, no framework hints. */
  readonly prompt: string;
  readonly flavours: readonly Flavour[];
  readonly expect: {
    /** `type@version` keys the contract lock must hold afterwards. */
    readonly operations?: readonly string[];
    /** Event types the domain must define afterwards. */
    readonly events?: readonly string[];
    /** Whether the change must come with new tests. */
    readonly newTests?: boolean;
  };
}

export function loadTasks(only?: string): EvalTask[] {
  const tasks = readdirSync(tasksDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(tasksDir, file), "utf8")) as EvalTask);
  return only === undefined ? tasks : tasks.filter((task) => task.name === only);
}

/** How each harness runs one prompt without a human: the prompt arrives as `$PROJECTED_EVAL_PROMPT`. */
export const AGENT_COMMANDS: Record<Harness, string> = {
  // The copy is disposable, so the agent may run anything in it.
  "claude-code": 'claude -p "$PROJECTED_EVAL_PROMPT" --permission-mode bypassPermissions --output-format json',
  codex: 'codex exec --full-auto "$PROJECTED_EVAL_PROMPT"',
  cursor: 'cursor-agent -p --force "$PROJECTED_EVAL_PROMPT"',
};

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=projected-evals", "-c", "user.email=evals@projected.invalid", ...args], { cwd: root, stdio: "pipe", encoding: "utf8" });

const SKIP = new Set(["node_modules", ".tsbuild", ".vitest-cache", ".stryker-tmp", "reports"]);

/** A copy of the example with its dependencies linked, committed, and set up for the harness. */
export function prepare(flavour: Flavour, dir: string, harness: Harness): string {
  const example = join(typescriptRoot, "examples", `school-${flavour}`);
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(example)) {
    if (!SKIP.has(entry)) cpSync(join(example, entry), join(dir, entry), { recursive: true });
  }
  // pnpm links are relative to the example: link each dependency to where it really is.
  const modules = join(example, "node_modules");
  for (const entry of readdirSync(modules)) {
    if (entry === ".bin") continue;
    const names = entry.startsWith("@") ? readdirSync(join(modules, entry)).map((name) => `${entry}/${name}`) : [entry];
    for (const name of names) {
      mkdirSync(dirname(join(dir, "node_modules", name)), { recursive: true });
      symlinkSync(realpathSync(join(modules, name)), join(dir, "node_modules", name), "dir");
    }
  }
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  symlinkSync(projectedBin, join(dir, "node_modules", ".bin", "projected"));
  writeFileSync(join(dir, ".gitignore"), [...SKIP].map((name) => `${name}/`).join("\n") + "\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "the school");
  const installed = installAgents(loadProject(dir), { harnesses: [harness] });
  if (!installed.ok) throw new Error(installed.lines.join("\n"));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "agents");
  return dir;
}

export interface AgentRun {
  readonly exitCode: number;
  readonly seconds: number;
  readonly log: string;
}

/** Run the agent command in the copy, the prompt in `PROJECTED_EVAL_PROMPT`. */
export function runAgent(command: string, dir: string, prompt: string, timeoutMs: number): Promise<AgentRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: dir, shell: true, env: { ...process.env, PROJECTED_EVAL_PROMPT: prompt, NO_COLOR: "1" } });
    let log = "";
    child.stdout.on("data", (chunk: Buffer) => (log += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (log += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, seconds: Math.round((Date.now() - started) / 1000), log });
    });
  });
}

export interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const countTests = (dir: string) =>
  readdirSync(join(dir, "test"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8").match(/\bit(\.each\([^)]*\))?\(/g)?.length ?? 0)
    .reduce((sum, n) => sum + n, 0);

/** Grade the copy as the agent left it, against the task and against the gate. */
export async function grade(task: EvalTask, dir: string, testsBefore: number): Promise<Check[]> {
  const checks: Check[] = [];
  const gate = await guard(loadProject(dir), { full: true });
  checks.push({ name: "gate", passed: gate.exitCode === 0, ...(gate.exitCode === 0 ? {} : { detail: gate.stdout.filter((l) => !l.endsWith(": ok")).slice(0, 12).join("\n") }) });

  const lockFile = join(dir, "contracts.lock.json");
  // Locked as "command suspend-student@1" or "query student-profile@2".
  const locked = existsSync(lockFile)
    ? Object.keys((JSON.parse(readFileSync(lockFile, "utf8")) as { operations?: Record<string, string> }).operations ?? {}).map((entry) => entry.replace(/^\S+ /, ""))
    : [];
  for (const key of task.expect.operations ?? []) {
    checks.push({ name: `operation ${key}`, passed: locked.includes(key) });
  }
  const domain = (() => {
    try {
      return git(dir, "grep", "-h", "--untracked", "defineEvent(", "--", "src/domain").split("\n");
    } catch {
      return []; // git grep exits with 1 when nothing matches
    }
  })();
  for (const event of task.expect.events ?? []) {
    checks.push({ name: `event ${event}`, passed: domain.some((line) => line.includes(`"${event}"`)) });
  }
  if (task.expect.newTests === true) {
    const after = countTests(dir);
    checks.push({ name: "new tests", passed: after > testsBefore, detail: `${testsBefore} → ${after}` });
  }
  // Getting green by switching a check off is a failure, however green it is.
  const diff = git(dir, "diff", "HEAD", "--", "src", "test");
  const weakened = /^\+.*(eslint-disable|@ts-ignore|@ts-nocheck|\bit\.skip\(|describe\.skip\()/m.test(diff);
  checks.push({ name: "no check switched off", passed: !weakened });
  return checks;
}

export interface Result {
  readonly task: string;
  readonly flavour: Flavour;
  readonly dir: string;
  readonly agent: AgentRun;
  readonly checks: readonly Check[];
  readonly passed: boolean;
}

/** One task on one flavour: prepare, run the agent, grade. */
export async function evaluate(task: EvalTask, flavour: Flavour, options: { readonly dir: string; readonly harness: Harness; readonly command: string; readonly timeoutMs: number }): Promise<Result> {
  const dir = prepare(flavour, options.dir, options.harness);
  const testsBefore = countTests(dir);
  const agent = await runAgent(options.command, dir, task.prompt, options.timeoutMs);
  writeFileSync(join(dir, "..", `${task.name}-${flavour}.agent.log`), agent.log);
  const checks = await grade(task, dir, testsBefore);
  return { task: task.name, flavour, dir, agent, checks, passed: checks.every((check) => check.passed) };
}
