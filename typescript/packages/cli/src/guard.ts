import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { checkArchitecture, formatViolations } from "@projected/architecture";
import { architecture, contractsLock, openapi, type CommandResult } from "./commands.js";
import { docs } from "./docs/commands.js";
import type { Project } from "./project.js";
import { vendorCheck } from "./vendor/commands.js";

/** The coding agents whose hooks `projected guard --hook` answers. */
export const HARNESSES = ["claude-code", "cursor", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export interface GuardOptions {
  /** Check these files (relative to the project root). Defaults to what git says changed. */
  readonly files?: readonly string[] | undefined;
  /** Only what is staged: for a pre-commit hook. */
  readonly staged?: boolean;
  /** The whole gate — compile, tests, `projected check` — instead of the changed files' rules. */
  readonly full?: boolean;
  /** Design-rule warnings fail too. */
  readonly strict?: boolean;
  /** Answer a coding agent's hook: read its event from `stdin`, reply the way it understands. */
  readonly hook?: Harness | undefined;
  /** The hook's event, as JSON. */
  readonly stdin?: string;
}

/** What the CLI prints, where, and the exit code — hooks read stderr and exit codes, not stdout. */
export interface GuardOutcome {
  readonly exitCode: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

const exec = promisify(execFile);

function git(root: string, args: readonly string[]): string[] | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    return undefined;
  }
}

/** Files changed since the last commit, untracked ones included — or only the staged ones. */
function changedFiles(root: string, staged: boolean): string[] | undefined {
  if (staged) return git(root, ["diff", "--cached", "--name-only", "--relative", "--diff-filter=ACMR"]);
  const tracked = git(root, ["diff", "HEAD", "--name-only", "--relative", "--diff-filter=ACMR"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
  return tracked === undefined ? undefined : [...new Set([...tracked, ...(untracked ?? [])])];
}

/** The file a hook event is about, when it names one (Claude Code's and Cursor's file edits do). */
function hookFile(root: string, stdin: string | undefined): string | undefined {
  if (stdin === undefined || stdin.trim() === "") return undefined;
  try {
    const event = JSON.parse(stdin) as { tool_input?: { file_path?: unknown }; file_path?: unknown };
    const path = event.tool_input?.file_path ?? event.file_path;
    if (typeof path !== "string") return undefined;
    return isAbsolute(path) ? relative(root, path) : path;
  } catch {
    return undefined;
  }
}

/** Whether the agent is already going round because a stop hook refused once. */
function continuing(stdin: string | undefined): boolean {
  if (stdin === undefined || stdin.trim() === "") return false;
  try {
    const event = JSON.parse(stdin) as { stop_hook_active?: unknown; loop_count?: unknown };
    return event.stop_hook_active === true || (typeof event.loop_count === "number" && event.loop_count > 0);
  } catch {
    return false;
  }
}

async function tool(project: Project, name: string, pkg: string, bin: string, args: readonly string[]): Promise<CommandResult> {
  const require = createRequire(join(project.root, "package.json"));
  let entry: string;
  try {
    entry = join(dirname(require.resolve(`${pkg}/package.json`)), bin);
  } catch {
    return { ok: true, lines: [`${name}: skipped — ${pkg} is not installed in the project`] };
  }
  try {
    await exec(process.execPath, [entry, ...args], { cwd: project.root, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } });
    return { ok: true, lines: [`${name}: ok`] };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    const output = `${failed.stdout ?? ""}${failed.stderr ?? ""}`.split("\n").filter((line) => line.trim() !== "");
    return { ok: false, lines: [`${name}: failed`, ...output.slice(-60).map((line) => `  ${line}`)] };
  }
}

/** The gate an agent must pass before it may call the work done: compile, test, check. */
async function fullGate(project: Project, strict: boolean): Promise<CommandResult> {
  const steps: Array<() => Promise<CommandResult>> = [
    () => tool(project, "compile", "typescript", "bin/tsc", ["-b"]),
    () =>
      tool(project, "tests", "vitest", "vitest.mjs", ["run", ...(existsSync(join(project.root, "vitest.config.ts")) ? ["--config", "vitest.config.ts"] : [])]),
    () => architecture(project, { strict }),
    () => contractsLock(project, { update: false, allowRemoval: false }),
    () => openapi(project, { check: true }),
    async () => vendorCheck(project),
    () => docs(project, { check: true }),
  ];
  const lines: string[] = [];
  let ok = true;
  for (const step of steps) {
    const result = await step().catch((error: unknown): CommandResult => ({ ok: false, lines: [`error: ${(error as Error).message}`] }));
    lines.push(...result.lines);
    ok &&= result.ok;
  }
  return { ok, lines };
}

const SOURCE = /^(src|test)\/.*\.(ts|mts|cts|tsx)$/;

/** The rules on the files that changed: seconds, for after every edit. */
async function fastCheck(project: Project, changed: readonly string[] | undefined, strict: boolean): Promise<CommandResult> {
  const files = changed?.filter((file) => SOURCE.test(file));
  if (files !== undefined && files.length === 0) return { ok: true, lines: ["guard: no source file changed"] };
  const report = await checkArchitecture(project.root, {
    flavour: project.flavour,
    ...(files === undefined ? {} : { files }),
    ...(project.config.applicationPackages === undefined ? {} : { applicationPackages: project.config.applicationPackages }),
    ...(project.config.domainPackages === undefined ? {} : { domainPackages: project.config.domainPackages }),
    designRules: project.config.rules ?? {},
  });
  const failing = strict ? [...report.violations, ...report.warnings] : report.violations;
  const scope = files === undefined ? "every file" : `${files.length} changed file${files.length === 1 ? "" : "s"}`;
  if (failing.length === 0) {
    return { ok: true, lines: [`guard: ${scope} keep every rule`, ...(report.warnings.length === 0 ? [] : [formatViolations(report.warnings)])] };
  }
  return { ok: false, lines: [`guard: ${failing.length} rule violation${failing.length === 1 ? "" : "s"} in ${scope}:`, formatViolations(failing)] };
}

/**
 * `projected guard`: the checks a coding agent runs as it works. After an edit, the project's
 * rules on the files that changed (seconds); with `--full`, before it calls the work done, the
 * whole gate — compile, tests and `projected check`. With `--hook <harness>`, it reads the
 * harness's hook event from stdin and answers in the harness's terms, so a failure reaches the
 * agent as something to fix.
 */
export async function guard(project: Project, options: GuardOptions = {}): Promise<GuardOutcome> {
  const strict = options.strict ?? false;
  let result: CommandResult;
  if (options.full === true) {
    result = await fullGate(project, strict);
  } else {
    // An edit hook names its file; otherwise (a patch, a commit, a shell) git says what changed.
    const edited = options.hook === undefined ? undefined : hookFile(project.root, options.stdin);
    const files = options.files ?? (edited === undefined ? changedFiles(project.root, options.staged ?? false) : [edited]);
    result = await fastCheck(project, files, strict);
  }
  if (options.hook === undefined) return { exitCode: result.ok ? 0 : 1, stdout: result.lines, stderr: [] };
  return answerHook(options.hook, options.full === true ? "stop" : "edit", result, options.stdin);
}

/**
 * How a harness hears a guard's result. Claude Code and Codex hand a hook's stderr to the agent
 * when it exits with 2 — after an edit as feedback, at a stop as the reason to keep going. Cursor
 * reads a stop hook's JSON from stdout, where a follow-up message sends the agent back to work.
 * At a stop, only once: an agent already sent back may stop, so an unfixable gate cannot loop.
 */
export function answerHook(harness: Harness, phase: "edit" | "stop", result: CommandResult, stdin?: string): GuardOutcome {
  if (result.ok) return { exitCode: 0, stdout: [], stderr: [] };
  const message = [
    phase === "stop"
      ? "projected guard: the work is not done — the gate fails. Fix these, then finish:"
      : "projected guard: the last edit breaks the project's rules. Fix these before going on:",
    ...result.lines,
  ];
  const sentBackAlready = phase === "stop" && continuing(stdin);
  if (harness === "cursor") {
    return phase === "edit" || sentBackAlready
      ? { exitCode: 0, stdout: [], stderr: message }
      : { exitCode: 0, stdout: [JSON.stringify({ followup_message: message.join("\n") })], stderr: [] };
  }
  return { exitCode: sentBackAlready ? 0 : 2, stdout: [], stderr: message };
}
