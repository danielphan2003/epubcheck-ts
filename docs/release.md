# Releasing

> For maintainers. The release process follows the parts of
> [t3code's release workflow](https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md)
> that apply to a library: every check gates publishing, the tarball is built once and smoke
> tested before it is published, and checksums come from the uploaded bytes.

## What the workflow does

- Workflow: `.github/workflows/release.yml`.
- Triggers:
  - a pushed tag matching `v*.*.*`, which builds exactly the tagged commit;
  - a manual run with a `version` input, which builds `main`'s HEAD and creates the tag when the
    release is published. Manual runs must select `main`, and refuse a version that is already tagged.
- `preflight` refuses a commit that is not on `main`, then runs `scripts/resolve-release.ts`: it
  validates the version, decides whether it is a prerelease, and finds the previous release tag
  that the generated notes compare with.
- `quality`, `test`, and `conformance` run the same checks as CI against the release commit.
  `conformance` fails if the committed score does not match what the commit passes.
- `pack` sets the release version in the packed manifest only and runs `pnpm pack`. The repository
  keeps version `0.0.0`. `pnpm pack` compiles `dist/` (`prepack`), copies `LICENSE` and
  `THIRD_PARTY_NOTICES.md` in, and replaces `catalog:` with the real versions.
- `smoke` installs that tarball into an empty project outside the workspace with
  `scripts/smoke-tarball.ts`. It runs the CLI on a valid and an invalid upstream fixture, imports
  both entry points, checks every export points at an existing file, and fails on unresolved
  `catalog:` or `workspace:` specs.
- `release` runs only if every job above passed. It is the only job with write access. It writes
  `SHA256SUMS` from the downloaded tarball and publishes one GitHub Release with both files.
  - A version with a suffix after `X.Y.Z` (`0.2.0-rc.1`) is a prerelease and is never marked latest.
  - Generated notes compare with the previous release tag. A stable release compares with the
    previous stable one, so its notes cover every prerelease in between.
- Releases are serialized (`concurrency: release`), never canceled, and queued rather than dropped.

CI runs the same pack and smoke test (`release_smoke` in `ci.yml`) on every pull request, so a
packaging break fails the pull request instead of the release.

## Releasing a version

1. Check that CI is green on `main`.
2. Run the **Release** workflow from `main` with the version, or push the tag:

   ```sh
   git tag v0.2.0 origin/main
   git push origin v0.2.0
   ```

3. Check that every job passed and that the release has `epubcheck-ts-<version>.tgz` and
   `SHA256SUMS`.

There is no dry run: a manual run or a pushed tag publishes a real release. To test the packaging
without publishing, run the smoke test locally:

```sh
cd packages/epubcheck && pnpm pack --out /tmp/epubcheck-ts.tgz && cd ../..
node scripts/smoke-tarball.ts --tarball /tmp/epubcheck-ts.tgz
```

## Not published

There is no npm package. Publishing one should use npm trusted publishing (OIDC) from this
workflow, with `id-token: write` only on the publishing job, as t3code does for its CLI.
