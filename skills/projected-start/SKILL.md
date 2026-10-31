---
name: projected-start
description: "Use when the user wants a new backend service, API or microservice built with projected, or asks to start, create, scaffold or kickstart a projected project, and there is no projected app yet (no package.json depending on @projected/*). Takes the user from a business idea to a running, tested, agent-ready service: picks the flavour, scaffolds it with the published CLI, installs, verifies, sets up the project's own skills and guard hooks, and builds the first feature."
category: software-development
---

# Starting a projected service

projected is a TypeScript framework for CQRS services. Its CLI, `@projected/cli` on npm, writes a
complete service: layers, composition root, HTTP server, auth, persistence, and tests that pass
from the start. Your job is to turn what the user wants into the right first command, check the
result, and hand over a service they can grow.

**Already in a projected app?** If a `package.json` here (or in a parent directory) depends on
`@projected/*` and there is a `projected.json`, stop: this skill is not for you. Use the
`projected` skill to build features in it.

## 1. Understand the service before creating it

Ask only for what you cannot infer, in one message. You need four things:

| You need | How to get it | Rules |
|---|---|---|
| the **service name** | the business capability it owns: `billing`, `enrolment`, `inventory` | kebab-case; it becomes the directory name and the API's name |
| its **first aggregate** | the main thing it keeps consistent: an `invoice`, a `student`, an `account` | camelCase (`invoice`, `lineItem`) and a noun, not a table or a verb |
| the **flavour** | see below; default to `state-based` | fixed for the life of the service |
| the **first feature** | one thing a user of the service does: "issue an invoice" | a business operation, not CRUD |

Choose the flavour from what the user says:

- **`state-based`** (the default): each aggregate is stored as its current state, and the events
  its changes emit go out through an outbox. Pick it unless something below applies.
- **`event-sourced`**: each aggregate is the sum of its events, and every change is kept forever.
  Pick it when the user needs an audit trail, a history of every change, "what did it look like
  on date X", or other services to replay what happened: ledgers, payments, compliance.

If the choice is unclear, say which one you picked and why, in a sentence, and go on. Don't ask
about anything the framework already decides: HTTP, database, auth, validation, OpenAPI and
messaging all come with it.

## 2. Check the tools

```sh
node --version   # needs v22.12 or newer
pnpm --version   # needs pnpm 10 or 11
git --version
```

- Node too old or missing: ask the user to install Node 22 LTS or newer (nvm, fnm, Volta or
  nodejs.org). Don't install it for them.
- pnpm missing: `corepack enable pnpm` (ships with Node), or `npm install -g pnpm` if corepack is
  unavailable.

## 3. Create the service

From the directory the service should live in:

```sh
npx --yes @projected/cli@latest new service <name> --flavour <state-based|event-sourced> --aggregate <aggregate>
```

The CLI refuses names its rules would reject, and writes nothing when it does. Its message says
what to change: read it, fix the name, and run the command again.

If the current directory is a pnpm workspace (it has a `pnpm-workspace.yaml`, here or above),
create the service where the workspace's `packages:` globs will include it, and run `pnpm install`
from the workspace root in step 4. Otherwise the service is a workspace of its own.

## 4. Install, generate, verify

```sh
cd <name>
git init
pnpm install
pnpm openapi && pnpm lock && pnpm catalog   # openapi.json, contracts.lock.json, docs/catalog.md
pnpm check                                  # compile, tests, and projected check
```

`pnpm check` must pass before you go on. A fresh service passes it; if it doesn't, see
**When something fails** below rather than changing the generated code to get green.

## 5. Set the project up for agents

```sh
pnpm exec projected agents install
git add -A && git commit -m "Create <name> with projected"
```

This writes `AGENTS.md`, the projected skills (in `.agents/skills/`, `.claude/skills/` and
`.cursor/rules/`), each harness's hooks, and a git pre-commit hook that runs
`projected guard --staged`. Commit afterwards, because `projected guard` checks what changed
since the last commit.

Your harness may load the new skills and hooks only in a new session. Don't wait for that: read
`.agents/skills/projected/SKILL.md` now, and run `pnpm exec projected guard` yourself after each
edit until the hooks are active.

## 6. Build the first feature

Follow the golden path in `.agents/skills/projected/SKILL.md`. In short, start with the
generator, then make its stubs say what the business says:

```sh
pnpm exec projected new command issue-invoice --aggregate invoice --event InvoiceIssued
```

Names are business language: commands are `verb-noun` in kebab-case (`issue-invoice`, never
`create-invoice` or `update-invoice`); events are past-tense PascalCase facts (`InvoiceIssued`).
The generator refuses CRUD verbs and says why.

Fill in the domain rule, the contract's input, output and errors, and the tests. Then:

```sh
pnpm openapi && pnpm lock && pnpm catalog
pnpm exec projected guard --full    # done only when this is green
```

## 7. Run it and hand over

```sh
pnpm build && pnpm start            # http://localhost:3000, in memory
curl -s localhost:3000/health/ready
curl -s localhost:3000/openapi.json
```

Every operation needs a signed-in caller by default. Sign-up is at `/api/auth/sign-up/email`
(better-auth). With `DATABASE_URL=postgres://…` the service stores everything in PostgreSQL and
creates its tables at start.

Stop the server, then tell the user:

- what you created: the service, its flavour and why, and the first feature with its endpoint
  (`POST /commands/<type>/version/1`);
- how to run it and where its API is described (`openapi.json`, `docs/catalog.md`);
- how to grow it: ask for the next feature in business terms, and an agent in this project will
  follow the installed skills.

## When something fails

| Symptom | Cause and fix |
|---|---|
| `npx` gets `404 Not Found` for `@projected/cli` | the registry is unreachable, or a private registry in `.npmrc` does not proxy npmjs.org. Check `npm view @projected/cli version`. |
| `ERR_PNPM_IGNORED_BUILDS` naming esbuild | pnpm 11 wants build scripts approved. Services made by current CLI versions allow esbuild in `pnpm-workspace.yaml`; in your own workspace, add `allowBuilds:` with `esbuild: true` to its root `pnpm-workspace.yaml`. |
| `new: … exists and is not empty` | choose another name, or ask the user before touching what is there. |
| `pnpm check` fails on a fresh service | don't edit generated code to get green. Run `pnpm exec projected check` for the precise rule, and report its output to the user with the version from `pnpm list @projected/cli`. |
| `agents: not a git repository — no pre-commit hook` | run `git init`, then `pnpm exec projected agents install` again. |

Never switch off a check to get green: no `eslint-disable`, `@ts-ignore`, `@ts-expect-error` or
skipped test. The checks are what keep the service's design intact.
