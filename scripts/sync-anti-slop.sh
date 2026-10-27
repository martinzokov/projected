#!/usr/bin/env bash
# Refresh vendor/anti-slop from github.com/martinzokov/anti-slop.
#
# projected vendors (copies) anti-slop rather than using a submodule so that its skills are
# present in every checkout — including CI and cloud agent sessions that never run
# `git submodule update`. This script is the only supported way to change vendor/anti-slop:
# it records the upstream commit so the copy is always traceable.
#
# Usage: scripts/sync-anti-slop.sh [git-ref]   (defaults to the upstream default branch)
set -euo pipefail

repo="https://github.com/martinzokov/anti-slop"
ref="${1:-HEAD}"
root="$(cd "$(dirname "$0")/.." && pwd)"
target="$root/vendor/anti-slop"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet --filter=blob:none "$repo" "$work/anti-slop"
git -C "$work/anti-slop" checkout --quiet "$ref"
commit="$(git -C "$work/anti-slop" rev-parse HEAD)"
date="$(git -C "$work/anti-slop" log -1 --format=%cI)"

rm -rf "$target"
mkdir -p "$target"
cp -R "$work/anti-slop/skills" "$target/skills"
cp "$work/anti-slop/README.md" "$target/README.md"
cat > "$target/UPSTREAM.md" <<NOTE
# Vendored copy of anti-slop

- Source: $repo
- Commit: \`$commit\`
- Committed: $date

Do not edit files here by hand. Change them upstream, then run \`scripts/sync-anti-slop.sh\`.
The framework's own enforcement (\`typescript/packages/architecture\`) is derived from
\`skills/hexagonal-architecture-enforcement/configs/dependency-cruiser.js\` in this copy.
NOTE

echo "vendor/anti-slop now at $commit"
