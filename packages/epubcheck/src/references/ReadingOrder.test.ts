import { describe, expect, it } from "@effect/vitest";

import * as ReadingOrder from "./ReadingOrder.ts";
import * as Url from "./Url.ts";

const item = (path: string, mediaType: string) => [path, { mediaType }] as const;
const ids = new Map([
  ["a", 0],
  ["b", 1],
  ["c", 2],
]);
const context = (spine: ReadonlyArray<string>, locale?: string) => ({
  items: new Map([
    item("EPUB/c1.xhtml", "application/xhtml+xml"),
    item("EPUB/c2.xhtml", "application/xhtml+xml"),
    item("EPUB/c3.xhtml", "application/xhtml+xml"),
    item("EPUB/s.svg", "image/svg+xml"),
  ]),
  spine: spine.map((name) => `EPUB/${name}`),
  ids: new Map(["c1.xhtml", "c2.xhtml", "c3.xhtml", "s.svg"].map((name) => [`EPUB/${name}`, ids])),
  locale,
});
const SPINE = ["c1.xhtml", "c2.xhtml", "c3.xhtml"];

describe("ReadingOrder.tocFindings", () => {
  // Each row's findings are EPUBCheck 5.4.0's for a toc nav with these links, in a publication
  // whose content documents each have the IDs a, b and c, in that order.
  it.each([
    {
      name: "IDs out of order",
      hrefs: ["c1.xhtml#b", "c1.xhtml#a"],
      found: [["toc", "EPUB/c1.xhtml#a", "document"]],
    },
    {
      name: "documents out of order",
      hrefs: ["c2.xhtml", "c1.xhtml"],
      found: [["toc", "EPUB/c1.xhtml", "spine"]],
    },
    // A link without a fragment points at the start of its document, before every ID.
    {
      name: "a document after one of its IDs",
      hrefs: ["c1.xhtml#b", "c1.xhtml"],
      found: [["toc", "EPUB/c1.xhtml", "document"]],
    },
    // So does a fragment that names no ID.
    {
      name: "a scheme-based fragment",
      hrefs: ["c1.xhtml#b", "c1.xhtml#epubcfi(/4/2)"],
      found: [["toc", "EPUB/c1.xhtml#epubcfi(/4/2)", "document"]],
    },
    {
      name: "an SVG view",
      hrefs: ["s.svg#b", "s.svg#svgView(viewBox(0,0,1,1))"],
      spine: ["c1.xhtml", "s.svg", "c2.xhtml", "c3.xhtml"],
      found: [["toc", "EPUB/s.svg#svgView(viewBox(0,0,1,1))", "document"]],
    },
    // A link to an unknown ID leaves the order as it was.
    {
      name: "an unknown ID",
      hrefs: ["c1.xhtml#b", "c1.xhtml#zzz", "c1.xhtml#c", "c1.xhtml#a"],
      found: [["toc", "EPUB/c1.xhtml#a", "document"]],
    },
    // Going back in the spine starts the document order afresh.
    {
      name: "a document order after a spine one",
      hrefs: ["c3.xhtml#c", "c3.xhtml#a", "c2.xhtml#a", "c3.xhtml#b"],
      found: [
        ["toc", "EPUB/c3.xhtml#a", "document"],
        ["toc", "EPUB/c2.xhtml#a", "spine"],
      ],
    },
    // An item listed twice is at its last itemref.
    {
      name: "an item before one listed twice",
      hrefs: ["c1.xhtml", "c2.xhtml"],
      spine: ["c1.xhtml", "c2.xhtml", "c1.xhtml"],
      found: [["toc", "EPUB/c2.xhtml", "spine"]],
    },
    {
      name: "an item listed twice",
      hrefs: ["c2.xhtml", "c1.xhtml"],
      spine: ["c1.xhtml", "c2.xhtml", "c1.xhtml"],
      found: [],
    },
    {
      name: "an encoded ID and a resource outside the spine",
      hrefs: ["c1.xhtml#b", "i.png", "c1.xhtml#%61"],
      found: [["toc", "EPUB/c1.xhtml#a", "document"]],
    },
    {
      name: "orders in German",
      hrefs: ["c3.xhtml#c", "c3.xhtml#a", "c2.xhtml#a"],
      locale: "de",
      found: [
        ["toc", "EPUB/c3.xhtml#a", "Dokument"],
        ["toc", "EPUB/c2.xhtml#a", "Spine"],
      ],
    },
  ])("reports $name", ({ hrefs, spine, locale, found }) => {
    const urls = Url.checker("EPUB/nav.xhtml", { container: true });
    const links = hrefs.flatMap((href, index) => {
      const resolved = urls.check(href).resolved;
      return resolved === undefined
        ? []
        : [{ resolved, path: "EPUB/nav.xhtml", line: 1, column: index }];
    });
    const findings = ReadingOrder.tocFindings(links, context(spine ?? SPINE, locale));
    expect(findings.map(({ id, args }) => [id, ...args])).toEqual(
      found.map((args) => ["NAV-011", ...args]),
    );
  });
});
