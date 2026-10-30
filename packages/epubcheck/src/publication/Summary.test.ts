import { describe, expect, it } from "@effect/vitest";

import * as Summary from "./Summary.ts";

describe("Summary.fonts", () => {
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
    const found = Summary.fonts(css, "EPUB/style.css");
    const names = (wanted: boolean) => [
      ...new Set(found.filter((font) => font.embedded === wanted).map((font) => font.name)),
    ];
    expect([names(true), names(false)]).toEqual([embedded, remote]);
  });
});
