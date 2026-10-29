# epubcheck-ts

An independent TypeScript rewrite of [W3C EPUBCheck](https://github.com/w3c/epubcheck), built on
[Effect](https://effect.website). The goal is conformance parity with the reference EPUBCheck: the
same verdict and the same message IDs (`OPF-001`, `RSC-005`, `PKG-006`, ...) with the same
severities for the same input.

This is early work. See the conformance score below for what it checks today.

## Usage

The library and CLI run from source on Node.js 26 or later. There is no npm release yet.

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

Upstream suite: EPUBCheck v5.4.0. Passing **760 / 1251** scenarios (60.8%); scenarios that expect reported messages: **306 / 720** (42.5%).

| Area                                    | Passing | Total |      % |
| --------------------------------------- | ------: | ----: | -----: |
| `cli`                                   |       0 |    53 |   0.0% |
| `epub-accessibility`                    |       4 |     5 |  80.0% |
| `epub-dictionaries`                     |      11 |    34 |  32.4% |
| `epub-distributable-objects`            |       2 |     2 | 100.0% |
| `epub-edupub`                           |      14 |    32 |  43.8% |
| `epub-indexes`                          |       9 |    18 |  50.0% |
| `epub-multiple-renditions`              |      10 |    13 |  76.9% |
| `epub-previews`                         |       5 |    10 |  50.0% |
| `epub-region-nav`                       |       4 |    10 |  40.0% |
| `epub-scriptable-components`            |       1 |     2 |  50.0% |
| `epub2`                                 |      62 |    99 |  62.6% |
| `epub3/00-minimal`                      |       5 |     5 | 100.0% |
| `epub3/02-epub-publication-conformance` |       2 |     2 | 100.0% |
| `epub3/03-resources`                    |      61 |   129 |  47.3% |
| `epub3/04-ocf`                          |      73 |   100 |  73.0% |
| `epub3/05-package-document`             |      62 |   130 |  47.7% |
| `epub3/06-layouts`                      |      10 |    20 |  50.0% |
| `epub3/07-content-documents`            |     177 |   235 |  75.3% |
| `epub3/08-navigation-document`          |      35 |    40 |  87.5% |
| `epub3/09-media-overlays`               |      32 |    50 |  64.0% |
| `epub3/B-external-identifiers`          |       1 |     3 |  33.3% |
| `epub3/C-viewport-meta-tag`             |      34 |    34 | 100.0% |
| `epub3/D-vocabularies`                  |      70 |    79 |  88.6% |
| `epub3/E-obsolete-features`             |      28 |    72 |  38.9% |
| `epub3/G-media-type-registrations`      |       1 |     1 | 100.0% |
| `localization`                          |       5 |     7 |  71.4% |
| `reporting`                             |       0 |    24 |   0.0% |
| `unit-tests`                            |      42 |    42 | 100.0% |

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
