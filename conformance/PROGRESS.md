# Conformance progress

The score after each merged pull request. "Detects" counts the scenarios that expect at least one
reported message, which a checker that reports nothing cannot pass.

| PR                                                          | Change                                                         |     Passing |   Detects |
| ----------------------------------------------------------- | -------------------------------------------------------------- | ----------: | --------: |
| [#1](https://github.com/danielphan2003/epubcheck-ts/pull/1) | Bootstrap: toolchain, harness, no-op checker                   |  372 / 1251 |   0 / 720 |
| [#2](https://github.com/danielphan2003/epubcheck-ts/pull/2) | OCF container: ZIP reader, mimetype, file names, container.xml |  445 / 1251 |  67 / 720 |
| [#3](https://github.com/danielphan2003/epubcheck-ts/pull/3) | Schemas: RELAX NG engine, Schematron, NVDL rules               |  684 / 1251 | 306 / 720 |
| [#4](https://github.com/danielphan2003/epubcheck-ts/pull/4) | Units: viewport and URL fragment parsers, unit scenarios       |  760 / 1251 | 306 / 720 |
| [#5](https://github.com/danielphan2003/epubcheck-ts/pull/5) | Toolchain: Node 26 runtime, CI and types                       |  760 / 1251 | 306 / 720 |
| [#6](https://github.com/danielphan2003/epubcheck-ts/pull/6) | Package documents: metadata, manifest, spine, vocabularies     |  854 / 1251 | 400 / 720 |
| [#7](https://github.com/danielphan2003/epubcheck-ts/pull/7) | References: links between resources, encodings                 |  926 / 1251 | 472 / 720 |
| [#8](https://github.com/danielphan2003/epubcheck-ts/pull/8) | CLI: upstream command line, JSON and XML reports               |  987 / 1251 | 472 / 720 |
| [#9](https://github.com/danielphan2003/epubcheck-ts/pull/9) | Resources: fallbacks, core media types, resource types         | 1032 / 1251 | 517 / 720 |
