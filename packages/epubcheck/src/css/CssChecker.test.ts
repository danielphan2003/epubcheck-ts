import { describe, expect, it } from "@effect/vitest";

import * as Url from "../references/Url.ts";
import * as CssChecker from "./CssChecker.ts";

const sheet = (
  css: string,
  options: { version?: "2" | "3"; styleAttribute?: boolean; locale?: string } = {},
) =>
  CssChecker.check(css, {
    path: "EPUB/a.css",
    context: {
      version: options.version ?? "3",
      container: true,
      locale: options.locale,
      undeclaredClasses: [["-epub-media-overlay-active", "media:active-class"]],
    },
    offset: 0,
    styleAttribute: options.styleAttribute ?? false,
  });

describe("CssChecker.check", () => {
  // Each row's findings, positions and CSS-008 texts are EPUBCheck 5.4.0's.
  it.each([
    {
      name: "a bad declaration, then the next one",
      css: "p { 1color: red; direction: rtl }",
      found: [
        ["CSS-008", 1, 5, 'Token "1color" not allowed here, expecting a property name'],
        ["CSS-001", 1, 18, "direction"],
      ],
    },
    // Recovery skips to the next `;` or `}`, past the one that ended the empty value.
    {
      name: "a missing value, which swallows the next declaration",
      css: "p { color: ; unicode-bidi: x }",
      found: [["CSS-008", 1, 12, 'Token ";" not allowed here, expecting a property value']],
    },
    // A rule that fails to parse skips to the next `}`, which ends the following rule.
    {
      name: "a stray brace, which skips the next rule",
      css: "p { color: red }}\na { direction: rtl }",
      found: [["CSS-008", 1, 17, 'Token "}" not allowed here']],
    },
    {
      name: "a margin rule, read as declarations",
      css: '@page { margin: 0; @top-center { content: "x"; direction: rtl } }',
      found: [
        ["CSS-008", 1, 20, 'Token "@top-center" not allowed here, expecting a property name'],
        ["CSS-001", 1, 48, "direction"],
        ["CSS-008", 1, 65, 'Token "}" not allowed here'],
        ["CSS-008", 1, 65, "Premature end of grammar (expecting: '}')"],
      ],
    },
    {
      name: "a bad selector",
      css: "p > > q { } a { direction: rtl }",
      found: [
        ["CSS-008", 1, 5, 'Token ">" not allowed here'],
        ["CSS-001", 1, 17, "direction"],
      ],
    },
    // A block holds declarations unless a `{` comes before any `;` or `}`, whatever the rule.
    {
      name: "an unknown at-rule's declarations",
      css: "@unknown x { direction: rtl }",
      found: [["CSS-001", 1, 14, "direction"]],
    },
    {
      name: "keyframes",
      css: "@keyframes k { from { direction: rtl } 50% { x: y } }",
      found: [["CSS-001", 1, 23, "direction"]],
    },
    // A premature end is reported at the start of the last token.
    {
      name: "an unfinished declaration",
      css: "p { color: red",
      found: [["CSS-008", 1, 12, "Premature end of grammar (expecting: ';' or '}')"]],
    },
    {
      name: "an unfinished selector",
      css: "p",
      found: [["CSS-008", 1, 1, "Premature end of grammar (expecting: '{')"]],
    },
    {
      name: "an unfinished at-rule",
      css: "@media screen",
      found: [["CSS-008", 1, 8, "Premature end of grammar (expecting: ';' or '{')"]],
    },
    // The scanner reads the whole sheet first, so its errors come first.
    {
      name: "an unterminated string",
      css: 'p { content: "abc',
      found: [
        ["CSS-008", 1, 18, "Premature end of file"],
        ["CSS-008", 1, 14, "Premature end of grammar (expecting: ';' or '}')"],
      ],
    },
    // The string ends at the line break; the scanner then skips to the next `;`, `{` or `}`.
    {
      name: "a line break in a string",
      css: 'p { content: "a\nb"; direction: rtl }\nq { direction: rtl }',
      found: [
        ["CSS-008", 2, 15, 'The character "NEWLINE" is not allowed in "STRING" expressions'],
        ["CSS-001", 2, 5, "direction"],
        ["CSS-001", 3, 5, "direction"],
      ],
    },
    {
      name: "an unterminated comment",
      css: "/* abc",
      found: [["CSS-008", 1, 7, "Premature end of file"]],
    },
    {
      name: "a long unicode range",
      css: "p { unicode-range: U+1234567 }",
      found: [["CSS-008", 1, 28, 'Invalid unicode range expression "U+1234567"']],
    },
    // Upstream prints the code of the character after the quoted URL.
    {
      name: "text after a quoted URL",
      css: 'p { background: url("a.png" x) }',
      found: [["CSS-008", 1, 29, 'Invalid syntax "120"']],
    },
    {
      name: "an escaped name",
      css: "p { \\64 irection: rtl }",
      found: [["CSS-001", 1, 5, "direction"]],
    },
    // Known units are spelled in lowercase.
    {
      name: "quantities",
      css: "p { 10PX: x; .5em: y }",
      found: [
        ["CSS-008", 1, 5, 'Token "10px" not allowed here, expecting a property name'],
        ["CSS-008", 1, 14, 'Token ".5em" not allowed here, expecting a property name'],
      ],
    },
    // A no-break space is a name character, not whitespace.
    { name: "a no-break space", css: "p {\u00a0direction: rtl }", found: [] },
    // CR and CRLF break lines; a form feed does not.
    {
      name: "line breaks",
      css: "p { color: red }\rq { direction: rtl }\r\nr { direction: rtl }\fs { direction: rtl }",
      found: [
        ["CSS-001", 2, 5, "direction"],
        ["CSS-001", 3, 5, "direction"],
        ["CSS-001", 3, 26, "direction"],
      ],
    },
    {
      name: "prefixed properties and values",
      css: "p { -EPUB-writing-mode: x; text-transform: -epub-fullwidth }",
      found: [
        ["OBS-001", 1, 5, "css-prefixed-property", "-epub-writing-mode"],
        ["OBS-001", 1, 28, "css-prefixed-value", "-epub-fullwidth"],
      ],
    },
    // Upstream knows one prefixed value, in lowercase.
    {
      name: "other prefixed values",
      css: "p { writing-mode: -epub-vertical-rl; text-transform: -EPUB-FULLWIDTH }",
      found: [],
    },
    { name: "a fixed position", css: "p { position: FIXED }", found: [["CSS-006", 1, 5]] },
    {
      name: "empty URLs",
      css: '@import ""; p { background: url(" ") }',
      found: [
        ["CSS-002", 1, 9],
        ["CSS-002", 1, 17],
      ],
    },
    // An unquoted URL runs to the next `)`, here the end of the sheet.
    {
      name: "an empty unquoted URL",
      css: "@font-face { font-family: X; src: url(); }",
      found: [
        ["CSS-008", 1, 43, "Premature end of file"],
        ["CSS-028", 1, 14],
        ["CSS-008", 1, 35, "Premature end of grammar (expecting: ';' or '}')"],
      ],
    },
    {
      name: "a font face without declarations",
      css: "@font-face { 1: x }",
      found: [
        ["CSS-008", 1, 14, 'Token "1" not allowed here, expecting a property name'],
        ["CSS-019", 1, 1],
      ],
    },
    // Upstream's scanner fails reading past the end, and its handler indexing an empty rule.
    {
      name: "a URL at the end",
      css: "p { background: url(",
      found: [
        ["CSS-008", 1, 21, "Premature end of file"],
        ["PKG-008", -1, -1, "null"],
      ],
    },
    {
      name: "an empty import",
      css: "@import;",
      found: [["PKG-008", -1, -1, "Index 0 out of bounds for length 0"]],
    },
    // Upstream's parser dies of a StackOverflowError; ours reports the sheet as unreadable.
    {
      name: "nesting deeper than the stack",
      css: `a { b: ${"(".repeat(100_000)}`,
      found: [["PKG-008", -1, -1, "null"]],
    },
    { name: "EPUB 2", css: "p { direction: rtl }", version: "2", found: [] },
    // A style attribute is a declaration list: a `}` is just a token.
    {
      name: "a brace in a style attribute",
      css: "color: red }",
      styleAttribute: true,
      found: [["CSS-008", 1, 12, 'Token "}" not allowed here']],
    },
    {
      name: "an unfinished style attribute",
      css: "color:",
      styleAttribute: true,
      found: [["CSS-008", 1, 6, "Premature end of grammar (expecting: ';' or '}')"]],
    },
    // An error ends a style attribute's checks.
    {
      name: "an error in a style attribute",
      css: "color: ; direction: rtl",
      styleAttribute: true,
      found: [["CSS-008", 1, 8, 'Token ";" not allowed here, expecting a property value']],
    },
    // The parser's own text, as MessageFormat reads the bundle's unbalanced quote.
    {
      name: "a localized error",
      css: "p { 1: x }",
      locale: "fr",
      found: [["CSS-008", 1, 5, 'Le token "1" nest pas autorisé à cet endroit, {1} attendu']],
    },
    // Classes of the selector itself count, escaped or not; those in arguments do not.
    {
      name: "a Media Overlays class",
      css: "p, .-epub-media-overlay-active b { }",
      found: [["CSS-029", 1, 4, "-epub-media-overlay-active", "media:active-class"]],
    },
    { name: "a commented class", css: "/* .-epub-media-overlay-active { } */", found: [] },
    { name: "a class in an argument", css: "a:not(.-epub-media-overlay-active) { }", found: [] },
    {
      name: "a class after a pseudo-class",
      css: ":not(p).-epub-media-overlay-active { }",
      found: [["CSS-029", 1, 1, "-epub-media-overlay-active", "media:active-class"]],
    },
    {
      name: "an escaped class",
      css: ".\\-epub-media-overlay-active { }",
      found: [["CSS-029", 1, 1, "-epub-media-overlay-active", "media:active-class"]],
    },
    { name: "another class", css: ".-epub-media-overlay-active2 { }", found: [] },
  ] as const)("reports $name", ({ css, found, ...options }) => {
    const { findings } = sheet(css, options);
    expect(findings.map(({ id, line, column, args }) => [id, line, column, ...args])).toEqual(
      found,
    );
  });

  // The references and positions upstream registers: declarations at their start, `@import`
  // at its URL.
  it.each([
    {
      name: "a declaration",
      css: ".a { background: url(a.png); }",
      references: [["generic", 1, 6, "EPUB/a.png"]],
    },
    {
      name: "quoted and spaced URLs",
      css: '.a {\n  background: url( "a.png" ) }',
      references: [["generic", 2, 3, "EPUB/a.png"]],
    },
    {
      name: "imports",
      css: "@import url(\"a.css\") screen;\n@import 'b.css';",
      references: [
        ["stylesheet", 1, 9, "EPUB/a.css"],
        ["stylesheet", 2, 9, "EPUB/b.css"],
      ],
    },
    // `url (` is no URL token, so there is nothing to import.
    { name: "a spaced import", css: '@import url ("a.css");', references: [] },
    // Only a rule's or declaration's own components count, not those inside functions.
    {
      name: "an image set",
      css: ".a { background-image: image-set(url(a.png) 1x, url(b.png) 2x); }",
      references: [],
    },
    { name: "a supports condition", css: "@supports (background: url(a.png)) { }", references: [] },
    {
      name: "a namespace",
      css: "@namespace epub url(http://www.idpf.org/2007/ops);",
      references: [],
    },
    { name: "a comment", css: "/* url(a.png) */ p { color: red }", references: [] },
    { name: "a string", css: 'p::before { content: "see url(a.png)"; }', references: [] },
    {
      name: "a font",
      css: "@font-face { font-family: x; src: url(f.woff); }",
      references: [["font", 1, 30, "EPUB/f.woff"]],
    },
    {
      name: "fragment-only URLs",
      css: "@font-face { src: url(#f) } p { background: url(#x) }",
      references: [],
    },
  ] as const)("registers $name", ({ css, references }) => {
    const found = sheet(css).references;
    expect(
      found.map((each) => [each.type, each.line, each.column, Url.referenceName(each)]),
    ).toEqual(references);
  });

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
@media print { @font-face { font-family: InMedia; font-style: NORMAL; src: url(m.woff) } }
body { color: red; }`,
      embedded: [
        "Foo Sans",
        "Bar,italic,bold",
        "Open,italic,bold",
        "Mixed,italic,bold",
        "Quoted,italic,bold",
        "NoSrc,italic,bold",
        "InMedia,bold",
      ],
      remote: ["Remote,italic,bold", "Mixed2,italic,bold", "Local,italic,bold"],
    },
  ])("names the fonts of $name", ({ css, embedded, remote }) => {
    const { fonts } = sheet(css);
    const names = (wanted: boolean) => [
      ...new Set(fonts.filter((font) => font.embedded === wanted).map((font) => font.name)),
    ];
    expect([names(true), names(false)]).toEqual([embedded, remote]);
  });
});

describe("CssChecker.decodeFile", () => {
  const bytes = (...values: ReadonlyArray<number | string>) =>
    new Uint8Array(
      values.flatMap((value) =>
        typeof value === "number" ? [value] : [...new TextEncoder().encode(value)],
      ),
    );
  // Each row's findings are EPUBCheck 5.4.0's, and its text what upstream's parser reads.
  it.each([
    { name: "no charset", input: bytes("p{}"), found: [], text: "p{}" },
    { name: "a UTF-8 mark", input: bytes(0xef, 0xbb, 0xbf, "p{}"), found: [], text: "p{}" },
    // The mark wins over the rule.
    {
      name: "a UTF-8 mark and a charset",
      input: bytes(0xef, 0xbb, 0xbf, '@charset "iso-8859-1";'),
      found: [],
      text: '@charset "iso-8859-1";',
    },
    {
      name: "a declared charset",
      input: bytes('@charset "ISO-8859-1"; p { content: "', 0xe9, '" }'),
      found: [["CSS-004", "iso-8859-1"]],
      text: '@charset "ISO-8859-1"; p { content: "é" }',
    },
    // Upstream reads any quote, and no space, but only a lowercase `@charset`.
    {
      name: "single quotes",
      input: bytes("@charset 'x';"),
      found: [["CSS-004", "x"]],
      text: "@charset 'x';",
    },
    {
      name: "no space",
      input: bytes('@charset"x";'),
      found: [["CSS-004", "x"]],
      text: '@charset"x";',
    },
    { name: "an uppercase rule", input: bytes('@CHARSET "x";'), found: [], text: '@CHARSET "x";' },
    { name: "an empty name", input: bytes("@charset '';"), found: [], text: "@charset '';" },
    {
      name: "a UTF-16 mark",
      input: bytes(0xfe, 0xff, 0x00, 0x70, 0x00, 0x7b, 0x00, 0x7d),
      found: [["CSS-003", "utf-16be"]],
      text: "p{}",
    },
    {
      name: "a UTF-32 mark",
      input: bytes(0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x70),
      found: [["CSS-004", "utf-32be"]],
      text: "p",
    },
    // Upstream pushes back the wrong byte when the file is shorter than its four-byte read.
    { name: "only a UTF-8 mark", input: bytes(0xef, 0xbb, 0xbf), found: [], text: "�" },
  ])("reads $name", ({ input, found, text }) => {
    const decoded = CssChecker.decodeFile(input, "EPUB/a.css");
    expect(decoded.findings.map(({ id, args }) => [id, ...args])).toEqual(found);
    expect(decoded.text).toBe(text);
  });
});
