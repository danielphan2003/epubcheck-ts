# epubcheck-ts

An independent TypeScript rewrite of [W3C EPUBCheck](https://github.com/w3c/epubcheck), built on
[Effect](https://effect.website). The goal is conformance parity with the reference EPUBCheck: the
same verdict and the same message IDs (`OPF-001`, `RSC-005`, `PKG-006`, ...) with the same
severities for the same input.

This is early work. See the conformance score below for what it checks today.

## Usage

The library and CLI run from source on Node.js 24 or later. There is no npm release yet.

```sh
pnpm install
node packages/epubcheck/src/bin.ts book.epub
node packages/epubcheck/src/bin.ts book.epub --json report.json
node packages/epubcheck/src/bin.ts package.opf --mode opf -v 3.0
```

The CLI accepts EPUBCheck's options, with one or two dashes: `--mode`, `-v`, `--profile`, `--json`,
`--locale`, `-f`/`-e`/`-w`/`-u` (reporting level), `--failonwarnings`, and `-q`. It exits with 1
when it finds errors.

From Effect:

```ts
import * as Effect from "effect/Effect";
import { EpubCheck } from "epubcheck-ts";

const program = Effect.gen(function* () {
  const checker = yield* EpubCheck.EpubCheck;
  return yield* checker.check({ path: "book.epub" });
}).pipe(Effect.provide(EpubCheck.layer));
// Provide FileSystem and Path, for example with NodeServices.layer from @effect/platform-node.
```

From Promise code:

```ts
import { check } from "epubcheck-ts/promise";

const result = await check({ path: "book.epub" });
for (const message of result.messages) console.log(message.severity, message.id, message.message);
```

## Conformance

The score is the share of upstream EPUBCheck's own Cucumber scenarios that pass against
epubcheck-ts. The scenarios and fixtures are vendored from a pinned upstream tag in
`vendor/epubcheck`. CI fails any pull request that lowers the score.

A checker that reports nothing passes every scenario that expects no messages, so the second
number, scenarios that expect at least one reported message, is the better measure of what
epubcheck-ts detects.

<!-- conformance:start -->

Upstream suite: EPUBCheck v5.4.0. Passing **445 / 1251** scenarios (35.6%); scenarios that expect reported messages: **67 / 720** (9.3%).

| Area                                    | Passing | Total |      % |
| --------------------------------------- | ------: | ----: | -----: |
| `cli`                                   |       0 |    53 |   0.0% |
| `epub-accessibility`                    |       4 |     5 |  80.0% |
| `epub-dictionaries`                     |       8 |    34 |  23.5% |
| `epub-distributable-objects`            |       1 |     2 |  50.0% |
| `epub-edupub`                           |      14 |    32 |  43.8% |
| `epub-indexes`                          |       6 |    18 |  33.3% |
| `epub-multiple-renditions`              |       3 |    13 |  23.1% |
| `epub-previews`                         |       3 |    10 |  30.0% |
| `epub-region-nav`                       |       3 |    10 |  30.0% |
| `epub-scriptable-components`            |       1 |     2 |  50.0% |
| `epub2`                                 |      42 |    99 |  42.4% |
| `epub3/00-minimal`                      |       5 |     5 | 100.0% |
| `epub3/02-epub-publication-conformance` |       2 |     2 | 100.0% |
| `epub3/03-resources`                    |      59 |   129 |  45.7% |
| `epub3/04-ocf`                          |      68 |   100 |  68.0% |
| `epub3/05-package-document`             |      32 |   130 |  24.6% |
| `epub3/06-layouts`                      |      10 |    20 |  50.0% |
| `epub3/07-content-documents`            |     112 |   235 |  47.7% |
| `epub3/08-navigation-document`          |      17 |    40 |  42.5% |
| `epub3/09-media-overlays`               |      19 |    50 |  38.0% |
| `epub3/B-external-identifiers`          |       1 |     3 |  33.3% |
| `epub3/C-viewport-meta-tag`             |       0 |    34 |   0.0% |
| `epub3/D-vocabularies`                  |      30 |    79 |  38.0% |
| `epub3/E-obsolete-features`             |       3 |    72 |   4.2% |
| `epub3/G-media-type-registrations`      |       1 |     1 | 100.0% |
| `localization`                          |       1 |     7 |  14.3% |
| `reporting`                             |       0 |    24 |   0.0% |
| `unit-tests`                            |       0 |    42 |   0.0% |

<!-- conformance:end -->

`conformance/passing.txt` lists every passing scenario, and `conformance/PROGRESS.md` records the
score after each merged pull request.

## Development

See [AGENTS.md](AGENTS.md) for the toolchain and conventions.

```sh
pnpm check                 # format check, lint, typecheck, tests
pnpm conformance run       # run upstream's scenarios
pnpm conformance update    # refresh score.json, passing.txt, and the table above
pnpm fetch:epubcheck-jar   # download the reference jar (needs Java)
pnpm conformance diff      # compare message IDs and severities with the jar
```

## License

MIT. epubcheck-ts redistributes EPUBCheck's test suite and message bundles under EPUBCheck's
BSD-3-Clause license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
