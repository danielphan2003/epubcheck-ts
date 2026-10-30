# Conformance progress

The score after each merged pull request. "Detects" counts the scenarios that expect at least one
reported message, which a checker that reports nothing cannot pass.

| PR                                                            | Change                                                             |     Passing |   Detects |
| ------------------------------------------------------------- | ------------------------------------------------------------------ | ----------: | --------: |
| [#1](https://github.com/danielphan2003/epubcheck-ts/pull/1)   | Bootstrap: toolchain, harness, no-op checker                       |  372 / 1251 |   0 / 720 |
| [#2](https://github.com/danielphan2003/epubcheck-ts/pull/2)   | OCF container: ZIP reader, mimetype, file names, container.xml     |  445 / 1251 |  67 / 720 |
| [#3](https://github.com/danielphan2003/epubcheck-ts/pull/3)   | Schemas: RELAX NG engine, Schematron, NVDL rules                   |  684 / 1251 | 306 / 720 |
| [#4](https://github.com/danielphan2003/epubcheck-ts/pull/4)   | Units: viewport and URL fragment parsers, unit scenarios           |  760 / 1251 | 306 / 720 |
| [#5](https://github.com/danielphan2003/epubcheck-ts/pull/5)   | Toolchain: Node 26 runtime, CI and types                           |  760 / 1251 | 306 / 720 |
| [#6](https://github.com/danielphan2003/epubcheck-ts/pull/6)   | Package documents: metadata, manifest, spine, vocabularies         |  854 / 1251 | 400 / 720 |
| [#7](https://github.com/danielphan2003/epubcheck-ts/pull/7)   | References: links between resources, encodings                     |  926 / 1251 | 472 / 720 |
| [#8](https://github.com/danielphan2003/epubcheck-ts/pull/8)   | CLI: upstream command line, JSON and XML reports                   |  987 / 1251 | 472 / 720 |
| [#9](https://github.com/danielphan2003/epubcheck-ts/pull/9)   | Resources: fallbacks, core media types, resource types             | 1033 / 1251 | 518 / 720 |
| [#10](https://github.com/danielphan2003/epubcheck-ts/pull/10) | Profiles: dictionaries, EDUPUB, indexes, previews, data navigation | 1091 / 1251 | 576 / 720 |
| [#11](https://github.com/danielphan2003/epubcheck-ts/pull/11) | Layout: fixed-layout viewports, page spreads                       | 1113 / 1251 | 598 / 720 |
| [#12](https://github.com/danielphan2003/epubcheck-ts/pull/12) | Media overlays: clips, text references, styling                    | 1130 / 1251 | 615 / 720 |
| [#13](https://github.com/danielphan2003/epubcheck-ts/pull/13) | Content documents: XHTML and SVG rules                             | 1146 / 1251 | 631 / 720 |
| [#14](https://github.com/danielphan2003/epubcheck-ts/pull/14) | Package URLs: manifest and link URLs, container coverage           | 1163 / 1251 | 647 / 720 |
| [#15](https://github.com/danielphan2003/epubcheck-ts/pull/15) | Vocabularies: epub:type values, link classes                       | 1174 / 1251 | 658 / 720 |
| [#16](https://github.com/danielphan2003/epubcheck-ts/pull/16) | EPUB 2: package rules, NCX, OPS doctypes, guide                    | 1196 / 1251 | 679 / 720 |
