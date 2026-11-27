#!/bin/sh
# ember: image=docker.io/library/node:26.13.0-trixie@sha256:7c99901bfcd76ef5bf55251bdfa2be541400ba964321d9075fd55aba55fb3eba vcpus=4 memory=4096
# epubcheck-ts's CI: the jobs .github/workflows/ci.yml runs (format, lint,
# typecheck, test; the release tarball smoke test; the conformance check).
# Publishing stays on GitHub's tag release workflow.
# Radicle CI runs this file in an ember microVM (factory docs/radicle-ci.md)
# with the commit's tree as the working directory; locally it is `sh ci.sh`.
# Everything goes to stderr: CI keeps stdout as artifacts.
set -eu
exec >&2

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# The pnpm package.json pins, installed into the scratch directory when the
# machine has another one, so a local run never touches a global install.
pnpm_version=$(node -p 'require("./package.json").packageManager.split("@")[1]')
if [ "$(pnpm --version 2>/dev/null || true)" != "$pnpm_version" ]; then
  echo "Installing pnpm $pnpm_version into $scratch"
  npm install --silent --prefix "$scratch/pnpm" "pnpm@$pnpm_version"
  PATH=$scratch/pnpm/node_modules/.bin:$PATH
fi

# The conformance check verifies the vendored files by their git object ids at
# HEAD. CI gets the commit's tree without .git, so commit that tree into a
# throwaway repository: the blob ids are the same. Done before the install so
# only tracked files go in. A checkout keeps its own repository; a tree that
# merely sits inside some other repository gets its own.
if [ "$(git rev-parse --show-toplevel 2>/dev/null || true)" != "$(pwd -P)" ]; then
  git init -q
  git add -A
  git -c user.name=ci -c user.email=ci@localhost -c commit.gpgsign=false \
    commit -q --no-verify -m tree
fi

pnpm install --frozen-lockfile

echo "== Format, lint, typecheck, test"
pnpm run fmt:check
pnpm run lint
pnpm run typecheck
pnpm run test

echo "== Release smoke"
(cd packages/epubcheck && pnpm pack --out "$scratch/epubcheck-ts.tgz")
pnpm exec node scripts/smoke-tarball.ts --tarball "$scratch/epubcheck-ts.tgz"

# GitHub also ratchets the score against the base commit's committed results.
# CI here gets one commit's tree and no base, so this checks only that the
# committed results are current (as GitHub does for a base without a score);
# a drop in score/passing.txt shows in the patch's diff instead.
echo "== Conformance"
pnpm exec node conformance/src/bin.ts check
