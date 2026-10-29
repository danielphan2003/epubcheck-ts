import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import * as Navigation from "./Navigation.ts";

const ids = new Map([
  ["a", 0],
  ["b", 1],
  ["c", 2],
]);
const context = {
  spine: ["EPUB/c1.xhtml", "EPUB/c2.xhtml", "EPUB/c3.xhtml"],
  ids: new Map([
    ["EPUB/c1.xhtml", ids],
    ["EPUB/c2.xhtml", ids],
    ["EPUB/c3.xhtml", ids],
  ]),
};
const nav = (type: string, ...hrefs: ReadonlyArray<string>) =>
  `<nav epub:type="${type}"><ol>${hrefs.map((href) => `<li><a href="${href}">x</a></li>`).join("")}</ol></nav>`;

describe("Navigation.check", () => {
  // Each row's findings are EPUBCheck 5.4.0's for a publication whose spine is c1, c2 and c3,
  // each with the IDs a, b and c in that order.
  it.each([
    {
      name: "IDs out of order",
      navs: nav("toc", "c1.xhtml#b", "c1.xhtml#a"),
      found: [["NAV-011", "toc", "EPUB/c1.xhtml#a", "document"]],
    },
    {
      name: "documents out of order",
      navs: nav("toc", "c2.xhtml", "c1.xhtml"),
      found: [["NAV-011", "toc", "EPUB/c1.xhtml", "spine"]],
    },
    // A link without a fragment points at the start of its document, before every ID.
    {
      name: "a document after one of its IDs",
      navs: nav("toc", "c1.xhtml#b", "c1.xhtml"),
      found: [["NAV-011", "toc", "EPUB/c1.xhtml", "document"]],
    },
    // A link to an unknown ID leaves the order as it was.
    {
      name: "an unknown ID",
      navs: nav("toc", "c1.xhtml#b", "c1.xhtml#zzz", "c1.xhtml#c", "c1.xhtml#a"),
      found: [["NAV-011", "toc", "EPUB/c1.xhtml#a", "document"]],
    },
    // Going back in the spine starts the document order afresh.
    {
      name: "a document order after a spine one",
      navs: nav("toc", "c3.xhtml#c", "c3.xhtml#a", "c2.xhtml#a", "c3.xhtml#b"),
      found: [
        ["NAV-011", "toc", "EPUB/c3.xhtml#a", "document"],
        ["NAV-011", "toc", "EPUB/c2.xhtml#a", "spine"],
      ],
    },
    {
      name: "the links of two toc navs",
      navs: nav("toc", "c2.xhtml") + nav("toc", "c1.xhtml"),
      found: [["NAV-011", "toc", "EPUB/c1.xhtml", "spine"]],
    },
    // Only the toc's order is checked, and the last type upstream tests names the nav.
    { name: "a page list out of order", navs: nav("page-list", "c2.xhtml", "c1.xhtml"), found: [] },
    {
      name: "a remote link",
      navs: nav("toc page-list", "https://example.org/x"),
      found: [["NAV-010", "page-list", "https://example.org/x"]],
    },
    {
      name: "a remote link, as written",
      navs: nav("landmarks", " http://example.org/s "),
      found: [["NAV-010", "landmarks", " http://example.org/s "]],
    },
    {
      name: "other schemes",
      navs: nav("toc", "mailto:a@example.org", "data:text/plain,x"),
      found: [["NAV-010", "toc", "mailto:a@example.org"]],
    },
    {
      name: "an encoded ID and a resource outside the spine",
      navs: nav("toc", "c1.xhtml#b", "i.png", "c1.xhtml#%61"),
      found: [["NAV-011", "toc", "EPUB/c1.xhtml#a", "document"]],
    },
  ])("reports $name", ({ navs, found }) => {
    const parsed = Xml.parse(
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>${navs}</body></html>`,
    );
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    const findings = Navigation.check(parsed.success, "EPUB/nav.xhtml", context);
    const keyed = findings.map(({ id, args }) =>
      id === "NAV-011"
        ? [id, args[0], args[1], args[2]?.includes("spine") ? "spine" : "document"]
        : [id, ...args],
    );
    expect(keyed).toEqual(found);
  });
});
