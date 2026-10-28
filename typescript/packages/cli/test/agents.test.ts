import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { answerHook, guard, installAgents, loadProject } from "@projected/cli";
import { read, removeScratch, service } from "./service.js";

afterAll(removeScratch);

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: root, encoding: "utf8", stdio: "pipe" });

/** A generated service in a repository of its own, everything committed. */
function committed(): string {
  const root = service("event-sourced");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "the service");
  return root;
}

const clockRead = "export const now = Date.now();\n";

describe("projected guard", () => {
  it("checks the rules on the source files changed since the last commit", async () => {
    const root = committed();
    writeFileSync(join(root, "src/domain/invoice/clock.ts"), clockRead);
    writeFileSync(join(root, "notes.md"), "not source\n");

    const outcome = await guard(loadProject(root));

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toEqual([
      "guard: 1 rule violation in 1 changed file:",
      "src/domain/invoice/clock.ts:1  [eslint/no-restricted-syntax]  Do not read the clock here. Take the time as input, or inject the Clock port in the use case.",
    ]);
  }, 60_000);

  it("passes when nothing it checks has changed", async () => {
    const root = committed();
    writeFileSync(join(root, "notes.md"), "not source\n");

    const outcome = await guard(loadProject(root));

    expect(outcome).toEqual({ exitCode: 0, stdout: ["guard: no source file changed"], stderr: [] });
  }, 60_000);

  it("answers Claude Code's edit hook about the edited file, with exit code 2 and the reason on stderr", async () => {
    const root = committed();
    writeFileSync(join(root, "src/domain/invoice/clock.ts"), clockRead);
    const event = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(root, "src/domain/invoice/clock.ts") } });

    const outcome = await guard(loadProject(root), { hook: "claude-code", stdin: event });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr[0]).toBe("projected guard: the last edit breaks the project's rules. Fix these before going on:");
    expect(outcome.stderr.join("\n")).toContain("src/domain/invoice/clock.ts:1");
  }, 60_000);

  it("runs the whole gate with --full, failing on what only the compiler sees", async () => {
    const root = committed();
    writeFileSync(join(root, "src/domain/invoice/broken.ts"), "export const n: number = \"not a number\";\n");

    const outcome = await guard(loadProject(root), { full: true });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("compile: failed");
    expect(outcome.stdout.join("\n")).toContain("src/domain/invoice/broken.ts");
  }, 180_000);
});

describe("answering a harness's hook", () => {
  const failed = { ok: false, lines: ["compile: failed"] };

  it("sends Claude Code and Codex back to work at a stop, but only once", () => {
    for (const harness of ["claude-code", "codex"] as const) {
      expect(answerHook(harness, "stop", failed, JSON.stringify({ stop_hook_active: false })).exitCode).toBe(2);
      expect(answerHook(harness, "stop", failed, JSON.stringify({ stop_hook_active: true })).exitCode).toBe(0);
    }
  });

  it("gives Cursor a follow-up message at a stop, on stdout", () => {
    const outcome = answerHook("cursor", "stop", failed, JSON.stringify({ status: "completed", loop_count: 0 }));

    expect(outcome.exitCode).toBe(0);
    expect(JSON.parse(outcome.stdout[0] ?? "{}")).toEqual({
      followup_message: "projected guard: the work is not done — the gate fails. Fix these, then finish:\ncompile: failed",
    });
  });

  it("stays silent when the checks pass", () => {
    expect(answerHook("claude-code", "edit", { ok: true, lines: ["guard: ok"] })).toEqual({ exitCode: 0, stdout: [], stderr: [] });
  });
});

describe("projected agents install", () => {
  it("sets up AGENTS.md, the skills and every harness's hooks, and changes nothing when run again", () => {
    const root = committed();

    const first = installAgents(loadProject(root));
    const second = installAgents(loadProject(root));

    expect(first.ok).toBe(true);
    for (const file of [
      "AGENTS.md",
      ".agents/skills/projected/SKILL.md",
      ".agents/skills/projected-domain-modelling/references/event-sourced.md",
      ".claude/skills/projected-testing/SKILL.md",
      ".cursor/rules/projected-contracts.mdc",
    ]) {
      expect([file, existsSync(join(root, file))]).toEqual([file, true]);
    }
    expect(read(root, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(JSON.parse(read(root, ".claude/settings.json"))).toMatchObject({
      hooks: {
        PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ command: 'cd "$CLAUDE_PROJECT_DIR" && npx --no-install projected guard --hook claude-code' }] }],
        Stop: [{ hooks: [{ command: 'cd "$CLAUDE_PROJECT_DIR" && npx --no-install projected guard --full --hook claude-code' }] }],
      },
    });
    expect(JSON.parse(read(root, ".cursor/hooks.json"))).toEqual({ version: 1, hooks: { stop: [{ command: "npx --no-install projected guard --full --hook cursor" }] } });
    expect(read(root, ".git/hooks/pre-commit")).toContain('(cd "." && npx --no-install projected guard --staged) || exit 1');
    expect(second).toEqual({ ok: true, lines: ["agents: everything is up to date"] });
  });

  it("keeps what the project already had: its own instructions, settings and hooks", () => {
    const root = committed();
    writeFileSync(join(root, "AGENTS.md"), "# Billing\n\nInvoices are never deleted.\n");
    mkdirSync(join(root, ".claude"), { recursive: true });
    const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] };
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ model: "default", hooks: { PostToolUse: [theirs] } }));

    installAgents(loadProject(root));
    installAgents(loadProject(root));

    const agents = read(root, "AGENTS.md");
    const settings = JSON.parse(read(root, ".claude/settings.json")) as { model: string; hooks: { PostToolUse: unknown[] } };
    expect(agents.startsWith("# Billing\n\nInvoices are never deleted.\n\n<!-- projected:begin")).toBe(true);
    expect(agents.match(/projected:begin/g)).toHaveLength(1);
    expect(settings.model).toBe("default");
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.PostToolUse[0]).toEqual(theirs);
  });

  it("leaves someone else's pre-commit hook alone, saying what to add to it", () => {
    const root = committed();
    writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\nmake lint\n");

    const result = installAgents(loadProject(root));

    expect(read(root, ".git/hooks/pre-commit")).toBe("#!/bin/sh\nmake lint\n");
    expect(result.lines).toContain(
      "agents: .git/hooks/pre-commit exists and is not projected's; add this line to it: (cd \".\" && npx --no-install projected guard --staged) || exit 1",
    );
  });

  it("installs a pre-commit hook that refuses a commit breaking the rules", () => {
    const root = committed();
    installAgents(loadProject(root), { harnesses: [] });
    writeFileSync(join(root, "src/domain/invoice/clock.ts"), clockRead);
    git(root, "add", "-A");

    const commit = () => git(root, "commit", "-qm", "read the clock");

    expect(commit).toThrow(/no-restricted-syntax/);
  }, 60_000);
});
