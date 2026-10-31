# Coding agents

projected is built to be worked on by coding agents, held to the same rules as people. The skills
say how to work; `projected guard` checks the work as it happens; the gate decides when it is
done; evals measure how well that steers a real agent.

## Starting a project

The [`projected-start`](../skills/projected-start/SKILL.md) skill is for an agent with no project
yet. Given a business idea, it picks the flavour, creates the service with the published CLI
(`npx @projected/cli@latest new service …`), installs and verifies it, runs
`projected agents install` (below), commits, builds the first feature through the generators and
runs the service. From then on, the project's own skills and hooks take over.

Install it once, wherever you start projects:

| How | Command |
|---|---|
| [Skills CLI](https://github.com/vercel-labs/skills), for any harness it supports | `npx skills add martinzokov/projected --skill projected-start` |
| Claude Code, by hand | `mkdir -p ~/.claude/skills/projected-start && curl -fsSL https://unpkg.com/@projected/cli/skills/projected-start/SKILL.md -o ~/.claude/skills/projected-start/SKILL.md` |
| no install: tell the agent | *Read https://unpkg.com/@projected/cli/skills/projected-start/SKILL.md and follow it to start a billing service.* |

The skill ships inside `@projected/cli`, with the others (the package's `prepack` copies
`skills/`, the vendored skills and `spec/` into it), so unpkg serves the version that matches the
latest CLI. Then ask in business terms: *"Start a projected service for billing: customers get
invoices, and an invoice is issued once its lines are final."*

`projected-start` is not copied into projects by `projected agents install`: once a project
exists, the `projected` skill is the one to use, and `projected-start` sends an agent there.

## Setting a project up

```sh
projected agents install                          # Claude Code, Cursor and Codex
projected agents install --harness claude-code    # or just some of them
```

| Written | For | What it does |
|---|---|---|
| `AGENTS.md` (a marked block) | every agent | how to work here, which skill to read for which change, the guard and the gate |
| `.agents/skills/<name>/` | every agent | the projected skills and the two vendored ones, with their reference files |
| `.claude/skills/<name>/`, `CLAUDE.md` (`@AGENTS.md`) | Claude Code | skills it loads by description |
| `.claude/settings.json` hooks | Claude Code | `PostToolUse` on `Edit\|Write\|MultiEdit`: `projected guard --hook claude-code`; `Stop`: `projected guard --full --hook claude-code` |
| `.cursor/rules/<name>.mdc` | Cursor | agent-requested rules, one per skill, pointing at `.agents/skills/` |
| `.cursor/hooks.json` | Cursor | `stop`: `projected guard --full --hook cursor` |
| `.codex/hooks.json` | Codex | `PostToolUse` on `apply_patch` and `Stop`, as for Claude Code |
| `.git/hooks/pre-commit` | everyone | `projected guard --staged`: no commit breaks a rule, whoever makes it |

Running it again refreshes what it wrote and nothing else: text outside the `AGENTS.md` markers,
other settings and other hooks stay as they are. A pre-commit hook that is not projected's is
left alone, with the line to add printed instead.

The Claude Code hooks follow its hooks reference. Cursor's and Codex's hook formats change faster
than projected; check `.cursor/hooks.json` and `.codex/hooks.json` against your version (Codex asks
you to trust new hooks with `/hooks`). `AGENTS.md`, the skills and the pre-commit hook do not
depend on any hook format.

## `projected guard`

| Command | Checks | When |
|---|---|---|
| `projected guard` | layout, import boundaries and code rules on the source files changed since the last commit | after every edit — seconds |
| `projected guard --staged` | the same, on what is staged | before every commit |
| `projected guard --full` | compile, the project's tests, `projected check` | before the work is called done |

`--strict` also fails on design-rule warnings. With `--hook <harness>` it reads the harness's
hook event from stdin — the edited file, whether the agent was already sent back once — and
answers the way the harness listens:

| Harness | After an edit | At a stop |
|---|---|---|
| Claude Code, Codex | exit 2, the violations on stderr: shown to the agent | exit 2 with the failures: the agent keeps working — once, so an unfixable gate cannot loop |
| Cursor | (observe-only) | `{ "followup_message": ... }` on stdout: the agent goes back to work |

## Evals

```sh
cd typescript
pnpm evals                               # every task, with Claude Code
pnpm evals --harness codex --task suspend-student
pnpm evals --agent 'my-agent "$PROJECTED_EVAL_PROMPT"'
```

On demand only: they need a harness installed and signed in, and take minutes per task. Each task
in `typescript/evals/tasks/` is a requirement in a product owner's words — no file names, no
framework hints — run on a fresh copy of a school example, in a git repository of its own, set up
by `projected agents install`. What the agent leaves is graded:

- **the gate** — `projected guard --full`;
- **the task's expectations** — the operations in the contract lock (a renamed field must become
  a new version, the old one still locked), the events defined, new tests;
- **no check switched off** — an `eslint-disable`, `@ts-ignore` or skipped test in the diff
  fails the task, however green it is.

Copies, agent logs and `report.json` stay in `typescript/evals/.runs/`. The grading itself is
tested with scripted agents (`evals/test/evals.test.ts`): one that does nothing, one that does the
job with `projected new`, one that skips a test to get green. Run the evals after changing a
skill, a generator or a rule's message, and compare.
