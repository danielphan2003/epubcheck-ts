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
    // Upstream's parser does not read `url (` as a URL, so there is nothing to import.
    { name: "a spaced import", css: '@import url ("a.css");', urls: [] },
    // Only top-level values count, not those inside functions or conditions.
    {
      name: "an image set",
      css: ".a { background-image: image-set(url(a.png) 1x, url(b.png) 2x); }",
      urls: [],
    },
    { name: "a supports condition", css: "@supports (background: url(a.png)) { }", urls: [] },
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

describe("Collect.cssSelectors", () => {
  it.each([
    {
      name: "a selector list",
      css: "p,\n  .a > b { color: red }",
      selectors: [
        { text: "p", line: 1, column: 1 },
        { text: ".a > b ", line: 2, column: 3 },
      ],
    },
    {
      name: "rules in @media, not at-rule preludes or declarations",
      css: "@media print { .a { x: y } }\n@font-face { src: url(a.otf) }",
      selectors: [{ text: ".a ", line: 1, column: 16 }],
    },
    {
      name: "a selector after a comment, not one in a string",
      css: '/* .x { } */ .a[title=".b"] { }',
      selectors: [{ text: '.a[title=""] ', line: 1, column: 14 }],
    },
  ])("reads $name", ({ css, selectors }) => {
    expect(Collect.cssSelectors(css)).toEqual(selectors);
  });
});

// Each answer is EPUBCheck 5.4.0's CSS-029.
describe("Collect.fromCss", () => {
  const context = {
    version: "3",
    container: true,
    undeclaredClasses: [["-epub-media-overlay-active", "media:active-class"]],
  } as const;
  it.each([
    { css: "p, .-epub-media-overlay-active b { }", at: [[1, 4]] },
    { css: "/* .-epub-media-overlay-active { } */", at: [] },
    { css: "a:not(.-epub-media-overlay-active) { }", at: [] },
    { css: ":not(p).-epub-media-overlay-active { }", at: [[1, 1]] },
    { css: ".\\-epub-media-overlay-active { }", at: [[1, 1]] },
    { css: ".-epub-media-overlay-active2 { }", at: [] },
  ])("reports CSS-029 for $css", ({ css, at }) => {
    const { findings } = Collect.fromCss(css, "EPUB/a.css", context);
    expect(findings.map((finding) => [finding.line, finding.column])).toEqual(at);
  });
});

describe("Collect.fonts", () => {
  // Each row's lists are those EPUBCheck 5.4.0 reports for a publication with that style sheet.
  it.each([
    {
      name: "a family's styles, which later rules inherit",
      css: `@font-face { font-family: "Charis"; src: url(f0.otf); }
@font-face { font-family: "Charis"; font-style: italic; src: url(f1.otf); }
@font-face { font-family: "Charis"; font-weight: bold; src: url(f2.otf); }
@font-face { font-family: "Charis"; font-style: italic; font-weight: bold; src: url(f3.otf); }`,
      embedded: ["Charis", "Charis,italic", "Charis,italic,bold"],
      remote: [],
    },
    {
      name: "families, sources and comments",
      css: `@font-face { font-family: "Foo Sans"; src: url(fonts/a.otf); }
/* @font-face { font-family: Commented; src: url(fonts/a.otf); } */
@font-face { font-family: 'Bar'; font-style: italic; font-weight: bold; src: url("fonts/a.otf") format("opentype"); }
@font-face { font-family: Open Sans; src: url(fonts/a.otf); }
@font-face { font-family: Remote; src: url(https://example.org/r.woff); }
@font-face { font-family: Mixed; src: url(https://example.org/r.woff), url(fonts/a.otf); }
@font-face { font-family: Mixed2; src: url(fonts/a.otf), url(https://example.org/r.woff); }
@font-face { font-family: Local; src: local("Local Font"); }
@font-face { font-family: "Quoted", serif; src: url(fonts/a.otf); }
@font-face { font-family: NoSrc; }
body { color: red; }`,
      embedded: [
        "Foo Sans",
        "Bar,italic,bold",
        "Open,italic,bold",
        "Mixed,italic,bold",
        "Quoted,italic,bold",
        "NoSrc,italic,bold",
      ],
      remote: ["Remote,italic,bold", "Mixed2,italic,bold", "Local,italic,bold"],
    },
  ])("names $name", ({ css, embedded, remote }) => {
    const found = Collect.fonts(css, "EPUB/style.css");
    const names = (wanted: boolean) => [
      ...new Set(found.filter((font) => font.embedded === wanted).map((font) => font.name)),
    ];
    expect([names(true), names(false)]).toEqual([embedded, remote]);
  });
});
