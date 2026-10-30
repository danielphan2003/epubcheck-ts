# epubcheck-ts

epubcheck-ts is an independent TypeScript rewrite of [W3C EPUBCheck](https://github.com/w3c/epubcheck),
built on [Effect](https://effect.website) v4. The goal is conformance parity: for the same input,
report the same verdict and the same message IDs (`OPF-001`, `RSC-005`, `PKG-006`, ...) with the
same severities as the reference EPUBCheck.

These conventions are adopted from [t3code](https://github.com/pingdotgg/t3code). Treat them as
good defaults; the developer's instructions override anything here.

## Layout

- `packages/epubcheck` (`epubcheck-ts`): the library, the Promise wrapper (`epubcheck-ts/promise`),
  and the CLI (`src/bin.ts`).
- `conformance` (`@epubcheck-ts/conformance`): runs upstream's Cucumber scenarios against the
  library, keeps the score, and diffs against the reference jar.
- `scripts`: maintainer scripts (vendor sync, catalog generation, jar download).
- `vendor/epubcheck`: a pinned, verbatim, sparse copy of upstream EPUBCheck. Read-only. Never edit
  it by hand; run `pnpm sync:upstream [tag]`, then `pnpm generate:messages` and
  `pnpm generate:schemas`.

## The rewrite rule

Read upstream to learn behavior: which message a case reports, with which arguments and location.
Do not translate its Java classes. Write the TypeScript the way this codebase is written.

## Toolchain

The same choices as t3code: pnpm workspaces with a `catalog:` for shared versions, Vite+ (`vp`) for
lint (oxlint), format (oxfmt) and tests (Vitest), and `@tsc-rs/typescript` as the `typescript`
drop-in, which reports the Effect language-service diagnostics configured in `tsconfig.base.json`
as type errors. Node runs the `.ts` sources directly; the only build is `pnpm --filter epubcheck-ts build` (tsc to `dist/`), which `pnpm pack` runs for the release tarball. pnpm pins the Node
runtime (`devEngines.runtime`, Node 26) and puts it first on the PATH of every script; outside a
script, run `pnpm exec node`, since a bare `node` is whatever the machine has.

- `pnpm install` installs. Add a dependency with `pnpm add <pkg>` in the owning package (`pnpm add
  -w -D` for root tools). Never hand-edit dependency fields in `package.json`.
- `pnpm fmt` formats, `pnpm fmt:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` mirror CI.
  `pnpm check` runs all four. Run it before every commit.
- `vp test run <file>` runs one test file while you iterate.
- Generated files end in `.generated.ts`. Regenerate them; do not edit them.

## TypeScript

- `tsconfig.base.json` is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly`. Import local files with their `.ts` extension.
- Inferred types over annotations. No explicit return types unless inference cannot do the job.
- `any` is the enemy, and `as` casts are a last resort. Narrow with guards or decode with `Schema`.

## Effect

- Import Effect modules as namespaces from their subpaths: `import * as Effect from "effect/Effect"`.
  Lint rejects `import { Effect } from "effect"`.
- A capability is a method on a `Context.Service`. One module per service, in this order: imports,
  errors and schemas, the service class with its interface inline, `make`, then `layer`.
  Consumers import the module as a namespace (`import * as Report from "./report/Report.ts"`) and
  use `Report.Report` and `Report.layer`.
- Dependencies come from the environment (`yield* FileSystem.FileSystem`), never as parameters.
- Reusable effectful functions use `Effect.fn("Service.operation")`, not a function returning
  `Effect.gen`. Use `Effect.fnUntraced` for per-message or per-node hot paths, and say why nearby.
- Typed failures are `Schema.TaggedError` classes with structured fields and a fixed `message`.
  Catch with `Effect.catchTags({ ... })`, even for one tag. Core logic never throws.
- A validation finding is not a failure. Checkers report findings through the `Report` service;
  the error channel is for the checker's own problems.
- Parse untrusted data with `Schema` decoders at the boundary.
- `Effect.runPromise` and friends belong only at boundaries: `src/promise.ts`, `src/bin.ts`, and
  scripts.

## Tests

- Tests use `@effect/vitest` (patched, as in t3code, to import `vite-plus/test`): `it.effect` for
  Effect code, layers for test doubles. Replace external dependencies with layers; never mock the
  logic under test.
- Test behavior that can break: parsing of external formats, message selection, harness semantics.
  Skip what types already guarantee. Extend an existing table before adding a new `it`; use
  `it.effect.each` for tables, not a loop around `it`.
- No sleeps, no wall-clock assertions, no retries. A flaky test is fixed, not retried.
- Upstream's scenarios are the main test suite. Do not duplicate a scenario as a unit test unless
  it pins down logic the scenario cannot isolate.

## Conformance

- `pnpm conformance run [--filter <text>] [--failures]` runs upstream's scenarios and prints the score.
- `pnpm conformance update` rewrites `conformance/score.json`, `conformance/passing.txt`, and the
  README table. Commit all three with the change that moved them.
- `pnpm conformance check` is what CI runs. It fails if the committed files are stale or if the
  score is below the base branch's.
- `pnpm fetch:epubcheck-jar` downloads the pinned reference jar into `.cache/` (needs Java).
  `pnpm conformance diff` then compares message IDs and severities with the jar on every scenario
  input, and `pnpm conformance run --oracle` answers every check with the jar, which validates the
  harness itself.
- A checker that reports nothing passes every scenario that expects no messages, so watch the
  "scenarios expecting reported messages" number too. CI fails if either number drops.
- The oracle cannot pass scenarios that depend on message order (`following ... are reported`
  tables, `the message contains` after repeated IDs): the jar's JSON report sorts messages.
- `conformance check` also fails if anything under `vendor/epubcheck` differs from the upstream
  objects recorded in `UPSTREAM.json`.

## Pull requests

- Never commit or push to `main`. Work on a branch and land it through a pull request.
- Titles are Conventional Commits (`feat(opf): ...`, `fix(ocf): ...`, `chore(ci): ...`); the squash
  merge uses the title.
- Every PR raises the conformance score, or holds it while improving structure. Put the score delta
  in the description and add a line to `conformance/PROGRESS.md`.
- Commits are unsigned.

## Comments and docs

- Default to no comment. Write one for a constraint, an upstream quirk, or an invariant the code
  cannot show, in one line where you can and four at most.
- Do not commit plans, research notes, or scratch files.
