# Third-party notices

epubcheck-ts is an independent rewrite. It is MIT licensed (see [LICENSE](LICENSE)), but it
redistributes material from the projects below under their own licenses.

## W3C EPUBCheck

- Project: https://github.com/w3c/epubcheck
- Version: the tag and commit recorded in [`vendor/epubcheck/UPSTREAM.json`](vendor/epubcheck/UPSTREAM.json)
- License: BSD-3-Clause, full text in [`vendor/epubcheck/LICENSE.md`](vendor/epubcheck/LICENSE.md)

What we redistribute, all verbatim under `vendor/epubcheck/` except where noted:

- `src/test/resources/`: the Cucumber feature files and EPUB fixtures that the conformance
  runner executes. Some fixtures embed third-party fonts as test inputs, such as Open Sans
  (Apache-2.0) in `epub3/03-resources/files/resources-cmt-font-*`.
- `src/main/resources/com/adobe/epubcheck/messages/`: the message bundles. The message catalog
  in `packages/epubcheck/src/messages/catalog.generated.ts` is generated from them.
- `src/main/java/com/adobe/epubcheck/messages/DefaultSeverities.java`: read by
  `scripts/generate-messages.ts` only, as the source of each message's default severity. No Java
  code is compiled, run, or translated.

```
Copyright © 2007 Adobe Systems Incorporated
Copyright © 2008 IDPF
Copyright © 2017 W3C (MIT, ERCIM, Keio, Beihang)

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

The reference EPUBCheck jar used by `pnpm conformance diff` is downloaded at run time by
`scripts/fetch-epubcheck-jar.ts` into the gitignored `.cache/` directory. It is never committed or
redistributed.

## t3code

- Project: https://github.com/pingdotgg/t3code
- License: MIT

`patches/@effect__vitest@4.0.7.patch` follows t3code's patch of `@effect/vitest`, which points it
at `vite-plus/test`. The tool configuration in `tsconfig.base.json` and `vite.config.ts` is adapted
from t3code's.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
