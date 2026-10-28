# Conformance progress

The score after each merged pull request. "Detects" counts the scenarios that expect at least one
reported message, which a checker that reports nothing cannot pass.

| PR                                                          | Change                                                          |    Passing |   Detects |
| ----------------------------------------------------------- | --------------------------------------------------------------- | ---------: | --------: |
| [#1](https://github.com/danielphan2003/epubcheck-ts/pull/1) | Bootstrap: toolchain, harness, no-op checker                    | 372 / 1251 |   0 / 720 |
| [#2](https://github.com/danielphan2003/epubcheck-ts/pull/2) | OCF container: ZIP reader, mimetype, file names, container.xml  | 445 / 1251 |  67 / 720 |
| [#3](https://github.com/danielphan2003/epubcheck-ts/pull/3) | Schemas: RELAX NG engine, Schematron, NVDL rules, XML encodings | 662 / 1251 | 284 / 720 |
