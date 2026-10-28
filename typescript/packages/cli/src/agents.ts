import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandResult } from "./commands.js";
import { HARNESSES, type Harness } from "./guard.js";
import type { Project } from "./project.js";

/** The skills a projected app's agents read, by where they live in the framework's repository. */
const SKILLS: ReadonlyArray<{ readonly name: string; readonly from: string }> = [
  { name: "projected", from: "skills/projected" },
  { name: "projected-contracts", from: "skills/projected-contracts" },
  { name: "projected-domain-modelling", from: "skills/projected-domain-modelling" },
  { name: "projected-integrations", from: "skills/projected-integrations" },
  { name: "projected-testing", from: "skills/projected-testing" },
  { name: "properties-of-good-tests", from: "vendor/anti-slop/skills/properties-of-good-tests" },
  { name: "hexagonal-architecture-enforcement", from: "vendor/anti-slop/skills/hexagonal-architecture-enforcement" },
];

const BEGIN = "<!-- projected:begin — written by `projected agents install`; edit outside these markers -->";
const END = "<!-- projected:end -->";
const GUARD = "npx --no-install projected guard";

/** The framework's repository root, where the skills are: found from this module's location. */
function skillsRoot(): string | undefined {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, "skills", "projected", "SKILL.md"))) return dir;
  }
  return undefined;
}

/** A skill's `description`, from its frontmatter. */
function descriptionOf(skillFile: string): string {
  const match = /^description:\s*"?(.*?)"?\s*$/m.exec(readFileSync(skillFile, "utf8"));
  return match?.[1] ?? "";
}

/** Every file under `dir` with its content, for telling whether a copy is current. */
function tree(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((file) => `${relative(dir, file)}\n${readFileSync(file, "utf8")}`)
    .join("\n\u0000");
}

/** What changed in the project, file by file. */
class Writes {
  readonly lines: string[] = [];
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  file(path: string, content: string): void {
    const absolute = join(this.root, path);
    const before = existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
    if (before === content) return;
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    this.lines.push(`agents: ${before === undefined ? "created" : "updated"} ${path}`);
  }

  directory(path: string, from: string): void {
    const absolute = join(this.root, path);
    const existed = existsSync(absolute);
    if (existed && tree(absolute) === tree(from)) return;
    rmSync(absolute, { recursive: true, force: true });
    cpSync(from, absolute, { recursive: true, dereference: true });
    this.lines.push(`agents: ${existed ? "refreshed" : "created"} ${path}/`);
  }

  /** Replace the projected block in a text file, or add it, keeping everything else as it is. */
  block(path: string, block: string, fresh: (block: string) => string): void {
    const absolute = join(this.root, path);
    if (!existsSync(absolute)) return this.file(path, fresh(block));
    const text = readFileSync(absolute, "utf8");
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    this.file(path, start !== -1 && end > start ? `${text.slice(0, start)}${block}${text.slice(end + END.length)}` : `${text.replace(/\s*$/, "")}\n\n${block}\n`);
  }

  /** Merge projected's hooks into a JSON settings file, replacing the ones it wrote before. */
  json(path: string, merge: (settings: Record<string, unknown>) => Record<string, unknown>): void {
    const absolute = join(this.root, path);
    const settings = existsSync(absolute) ? (JSON.parse(readFileSync(absolute, "utf8")) as Record<string, unknown>) : {};
    this.file(path, `${JSON.stringify(merge(settings), null, 2)}\n`);
  }
}

const ours = (entry: unknown) => JSON.stringify(entry).includes("projected guard");

/** `hooks[event]` with projected's previous entries removed and `entry` added. */
function withHook(settings: Record<string, unknown>, event: string, entry: unknown): Record<string, unknown> {
  const hooks = { ...((settings["hooks"] as Record<string, unknown[]> | undefined) ?? {}) };
  hooks[event] = [...(hooks[event] ?? []).filter((existing) => !ours(existing)), entry];
  return { ...settings, hooks };
}

function agentsBlock(project: Project, skills: ReadonlyArray<{ name: string; description: string }>): string {
  return [
    BEGIN,
    "## Working in this service",
    "",
    `A [projected](https://github.com/martinzokov/projected) service, ${project.flavour}. The compiler and`,
    "`projected check` hold it to its architecture; the skills explain the rules and the golden path",
    "from a business requirement to a served, documented operation.",
    "",
    "**Before you change anything**, read the skill for the kind of change, in `.agents/skills/<name>/SKILL.md`:",
    "",
    "| Skill | Read it |",
    "|---|---|",
    ...skills.map((skill) => `| \`${skill.name}\` | ${skill.description.replace(/\|/g, "\\|")} |`),
    "",
    "**As you work:**",
    "",
    "- `projected new command|query|aggregate|port|event-handler` writes a change's files, tests and",
    "  wiring as stubs; then make the stubs say what the business says.",
    "- After every edit, `projected guard` checks the rules on what you changed.",
    "- Generated files are regenerated, never edited: `projected openapi`, `projected contracts --update`,",
    "  `projected docs`.",
    "- Never weaken a check to get green: no `eslint-disable`, `@ts-ignore` or `any`, no rule levels",
    "  lowered in `projected.json`, no tests skipped. A rule that blocks you names what to do instead.",
    "",
    "**Before you say it is done:** `projected guard --full` — compile, tests and `projected check` — passes.",
    END,
  ].join("\n");
}

/** Install the pre-commit hook in the repository the project is in, unless another hook is there. */
function gitHook(project: Project): string[] {
  let hooks: string;
  let top: string;
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: project.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    top = git("rev-parse", "--show-toplevel");
    hooks = join(project.root, git("rev-parse", "--git-path", "hooks"));
  } catch {
    return ["agents: not a git repository — no pre-commit hook (run this again after git init)"];
  }
  // Hooks run at the top of the repository; the service may be anywhere below it.
  const root = relative(top, project.root) || ".";
  const line = `(cd "${root}" && ${GUARD} --staged) || exit 1`;
  const block = `# projected:begin\n${line}\n# projected:end`;
  const path = join(hooks, "pre-commit");
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    if (!text.includes("# projected:begin")) {
      return [`agents: ${relative(project.root, path)} exists and is not projected's; add this line to it: ${line}`];
    }
    const updated = text.replace(/# projected:begin[\s\S]*?# projected:end/, block);
    if (updated !== text) writeFileSync(path, updated, { mode: 0o755 });
    return updated === text ? [] : [`agents: updated ${relative(project.root, path)}`];
  }
  mkdirSync(hooks, { recursive: true });
  writeFileSync(path, `#!/bin/sh\n# Checks staged changes against the project's rules before every commit.\n${block}\n`, { mode: 0o755 });
  return [`agents: created ${relative(project.root, path)}`];
}

export interface AgentsOptions {
  /** Which coding agents to set up. Defaults to all of them. */
  readonly harnesses?: readonly Harness[];
  /** Install the git pre-commit hook. Defaults to true. */
  readonly gitHook?: boolean;
}

/**
 * `projected agents install [--harness claude-code,cursor,codex]`: set a project up for coding
 * agents. Every agent gets `AGENTS.md` (how to work here, which skill to read when) and the skills
 * in `.agents/skills/`; each harness its own entry points — Claude Code's skills and hooks, Cursor's
 * rules and stop hook, Codex's hooks — and the repository a pre-commit hook. The hooks run
 * `projected guard`: the rules after every edit, the whole gate before the agent may stop.
 * Running it again updates what it wrote and leaves everything else alone.
 */
export function installAgents(project: Project, options: AgentsOptions = {}): CommandResult {
  const harnesses = options.harnesses ?? HARNESSES;
  const unknown = harnesses.filter((harness) => !HARNESSES.includes(harness));
  if (unknown.length > 0) return { ok: false, lines: [`agents: unknown harness ${unknown.join(", ")} — choose from ${HARNESSES.join(", ")}`] };
  const source = skillsRoot();
  if (source === undefined) return { ok: false, lines: ["agents: cannot find the projected skills next to @projected/cli — reinstall it"] };

  const writes = new Writes(project.root);
  const skills = SKILLS.map((skill) => ({ ...skill, description: descriptionOf(join(source, skill.from, "SKILL.md")) }));
  for (const skill of skills) writes.directory(`.agents/skills/${skill.name}`, join(source, skill.from));
  writes.block("AGENTS.md", agentsBlock(project, skills), (block) => `# Agents\n\n${block}\n`);

  if (harnesses.includes("claude-code")) {
    for (const skill of skills) writes.directory(`.claude/skills/${skill.name}`, join(source, skill.from));
    const claude = join(project.root, "CLAUDE.md");
    if (!existsSync(claude)) writes.file("CLAUDE.md", "@AGENTS.md\n");
    else if (!readFileSync(claude, "utf8").includes("@AGENTS.md")) writes.file("CLAUDE.md", `${readFileSync(claude, "utf8").replace(/\s*$/, "")}\n\n@AGENTS.md\n`);
    const run = (args: string) => ({ type: "command", command: `cd "$CLAUDE_PROJECT_DIR" && ${GUARD} ${args}` });
    writes.json(".claude/settings.json", (settings) =>
      withHook(
        withHook(settings, "PostToolUse", { matcher: "Edit|Write|MultiEdit", hooks: [run("--hook claude-code")] }),
        "Stop",
        { hooks: [run("--full --hook claude-code")] },
      ),
    );
  }
  if (harnesses.includes("cursor")) {
    for (const skill of skills) {
      writes.file(
        `.cursor/rules/${skill.name}.mdc`,
        `---\ndescription: ${JSON.stringify(skill.description)}\nglobs:\nalwaysApply: false\n---\n\nRead and follow \`.agents/skills/${skill.name}/SKILL.md\` before going on.\n`,
      );
    }
    writes.json(".cursor/hooks.json", (settings) => {
      const hooks = { ...((settings["hooks"] as Record<string, unknown[]> | undefined) ?? {}) };
      hooks["stop"] = [...(hooks["stop"] ?? []).filter((entry) => !ours(entry)), { command: `${GUARD} --full --hook cursor` }];
      return { version: 1, ...settings, hooks };
    });
  }
  if (harnesses.includes("codex")) {
    const run = (args: string) => ({ type: "command", command: `${GUARD} ${args}` });
    writes.json(".codex/hooks.json", (settings) =>
      withHook(withHook(settings, "PostToolUse", { matcher: "apply_patch", hooks: [run("--hook codex")] }), "Stop", {
        hooks: [run("--full --hook codex")],
      }),
    );
  }
  const hookLines = options.gitHook === false ? [] : gitHook(project);
  const lines = [...writes.lines, ...hookLines];
  return { ok: true, lines: lines.length === 0 ? ["agents: everything is up to date"] : lines };
}
