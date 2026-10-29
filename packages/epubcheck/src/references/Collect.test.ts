import { describe, expect, it } from "@effect/vitest";

import * as Collect from "./Collect.ts";

describe("Collect.cssUrls", () => {
  // URLs and positions as EPUBCheck 5.4.0 reports references from a style sheet: declarations
  // at their start, `@import` at its URL.
  it.each([
    {
      name: "a declaration",
      css: ".a { background: url(a.png); }",
      urls: [{ url: "a.png", kind: "url", fontFace: false, line: 1, column: 6 }],
    },
    {
      name: "quoted and spaced URLs",
      css: '.a {\n  background: url( "a.png" ) }',
      urls: [{ url: "a.png", kind: "url", fontFace: false, line: 2, column: 3 }],
    },
    {
      name: "imports",
      css: "@import url(\"a.css\") screen;\n@import 'b.css';",
      urls: [
        { url: "a.css", kind: "import", fontFace: false, line: 1, column: 9 },
        { url: "b.css", kind: "import", fontFace: false, line: 2, column: 9 },
      ],
    },
    { name: "a namespace", css: "@namespace epub url(http://www.idpf.org/2007/ops);", urls: [] },
    { name: "a comment", css: "/* url(a.png) */ p { color: red }", urls: [] },
    { name: "a string", css: 'p::before { content: "see url(a.png)"; }', urls: [] },
    {
      name: "a data URL with a nested url()",
      css: ".b { background: url(\"data:image/svg+xml,%3Crect fill='url(%23g)'/%3E\"); }",
      urls: [
        {
          url: "data:image/svg+xml,%3Crect fill='url(%23g)'/%3E",
          kind: "url",
          fontFace: false,
          line: 1,
          column: 6,
        },
      ],
    },
    {
      name: "a font",
      css: "@font-face { font-family: x; src: url(f.woff); }",
      urls: [{ url: "f.woff", kind: "url", fontFace: true, line: 1, column: 30 }],
    },
    // Like upstream's CSS parser, an unquoted URL ends at the first parenthesis.
    {
      name: "an escaped parenthesis",
      css: ".e { background: url(a\\(6\\).png); }",
      urls: [{ url: "a\\(6\\", kind: "url", fontFace: false, line: 1, column: 6 }],
    },
  ])("reads $name", ({ css, urls }) => {
    expect(Collect.cssUrls(css)).toEqual(urls);
  });
});

describe("Collect.srcsetUrls", () => {
  it.each([
    { srcset: "a.png 1x, b.png 2x", urls: ["a.png", "b.png"] },
    // As in HTML, a URL runs to the next space, commas included.
    { srcset: "a.png,b.png", urls: ["a.png,b.png"] },
    { srcset: "a.png 100w, b.png (max-width: 10px) 200w", urls: ["a.png", "b.png"] },
    {
      srcset: "data:image/png;base64,AAA= 1x, b.png 2x",
      urls: ["data:image/png;base64,AAA=", "b.png"],
    },
    { srcset: "data:image/png;base64,\n  AAA= 1x", urls: ["data:image/png;base64,AAA="] },
  ])("reads $srcset", ({ srcset, urls }) => {
    expect(Collect.srcsetUrls(srcset)).toEqual(urls);
  });
});
