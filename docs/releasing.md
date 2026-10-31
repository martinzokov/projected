# Releasing

The framework is published to npm as the [`@projected`](https://www.npmjs.com/org/projected) org:
the fifteen packages in `typescript/packages/`. The examples and the evals are private and never
published.

## One version for every package

Every package has the same version, and a release publishes all of them. Outside the workspace,
`projected new service` depends on each framework package at the CLI's own version (`^0.1.1`
from CLI 0.1.1), so a package left behind makes services that cannot install.
`scaffold.test.ts` fails while any package's version differs from the CLI's.

Between packages, dependencies are `workspace:*`; `pnpm publish` replaces each with the exact
version it depends on.

## What a package contains

`dist/`, `src/` (for source maps), `LICENSE` and `package.json`. The CLI also carries `bin/`, and
three things it reads at run time from the repository root: `skills/` and
`vendor/anti-slop/skills/` (written into projects by `projected agents install`) and `spec/` (the
suites `projected conformance` runs). Its `prepack` script, `scripts/pack-assets.mjs`, copies
them into the package before packing, and `postpack` removes the copies, so the workspace keeps
reading the originals. The copies are git-ignored in case a pack is interrupted.

Because the skills ship inside the CLI, each release also updates what
`https://unpkg.com/@projected/cli/skills/<skill>/SKILL.md` serves, which is how agents without a
project fetch `projected-start` ([coding agents](agents.md#starting-a-project)).

## Steps

1. **Bump** every package (patch, minor or major), from `typescript/`:

   ```sh
   pnpm -r --filter './packages/*' exec npm version <x.y.z> --no-git-tag-version
   ```

2. **Run the gate**, and the integration tests when a store or transport changed (see
   [`CLAUDE.md`](../CLAUDE.md)):

   ```sh
   pnpm install && pnpm check
   ```

3. **Try the packages as a user gets them**, before anything is public. Pack them, create a
   service outside the repository and point its framework dependencies at the tarballs:

   ```sh
   out=$(mktemp -d)
   pnpm -r --filter './packages/*' exec pnpm pack --pack-destination "$out"
   cd "$out" && node "$OLDPWD/packages/cli/bin/projected.js" new service billing --flavour state-based --aggregate invoice
   cd billing && git init
   printf 'overrides:\n' >> pnpm-workspace.yaml
   for f in "$out"/projected-*.tgz; do n=$(basename "$f" | sed -E 's/^projected-(.*)-[0-9.]+\.tgz$/\1/'); printf '  "@projected/%s": "file:%s"\n' "$n" "$f" >> pnpm-workspace.yaml; done
   pnpm install && pnpm openapi && pnpm lock && pnpm catalog && pnpm check
   pnpm exec projected agents install
   ```

   This catches what the workspace hides: a file missing from `files`, a dependency that only
   resolves because the workspace hoists it, a path that only exists in the repository.

4. **Commit and tag** the bump: `git commit -m "Release <x.y.z>"` and `git tag v<x.y.z>`.

5. **Publish**, from `typescript/`, in a terminal where npm can open a browser for two-factor
   authentication:

   ```sh
   pnpm build && pnpm -r --filter './packages/*' publish
   ```

   pnpm publishes in dependency order and skips versions that are already on the registry, so if
   it stops partway (an expired one-time password), run it again. pnpm refuses to publish from a
   branch other than `main` or with uncommitted changes; `--no-git-checks` overrides that.

6. **Check the release**: `npm view @projected/cli version` (new versions can take a few minutes
   to appear), then follow the `projected-start` skill in an empty directory with
   `npx @projected/cli@latest`, through to calling the first command on the running service.

A published version can never be published again, even after `npm unpublish`. A broken release is
fixed by the next one; mark the broken one with `npm deprecate @projected/<name>@<x.y.z> "<why>"`.
