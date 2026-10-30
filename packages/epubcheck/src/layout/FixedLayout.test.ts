import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as PackageDocument from "../opf/PackageDocument.ts";
import * as Xml from "../xml/Xml.ts";
import * as FixedLayout from "./FixedLayout.ts";

const parse = (source: string) => {
  const document = Xml.parse(source);
  if (Result.isFailure(document)) throw new Error(document.failure.message);
  return document.success;
};

const opf = (metadata: string, manifest: string, spine: string) =>
  PackageDocument.read(
    parse(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0"
      prefix="rend: http://www.idpf.org/vocab/rendition/#">
      <metadata>${metadata}</metadata>
      <manifest>${manifest}</manifest><spine>${spine}</spine></package>`),
    "EPUB/package.opf",
    "3",
  );

const layout = (value: string) => `<meta property="rendition:layout">${value}</meta>`;

const xhtml = (head: string, body = "") =>
  parse(
    `<html xmlns="http://www.w3.org/1999/xhtml"><head>${head}</head><body>${body}</body></html>`,
  );

// Each answer is EPUBCheck 5.4.0's.
describe("FixedLayout", () => {
  it.each([
    {
      name: "a fallback chain, one level only",
      metadata: layout("pre-paginated"),
      manifest: `<item id="a" href="a.foo" media-type="application/x-foo" fallback="b"/>
        <item id="b" href="b.foo" media-type="application/x-bar" fallback="c"/>
        <item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>`,
      spine: `<itemref idref="a"/>`,
      fixed: ["a", "b"],
    },
    {
      name: "a reflowable itemref in a roll publication",
      metadata: layout("roll"),
      manifest: `<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>`,
      spine: `<itemref idref="c" properties="rendition:layout-reflowable"/>`,
      fixed: ["c"],
    },
    {
      name: "an undefined roll itemref layout",
      metadata: layout("reflowable"),
      manifest: `<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>`,
      spine: `<itemref idref="c" properties="rendition:layout-roll"/>`,
      fixed: [],
    },
    {
      name: "an aliased rendition prefix",
      metadata: layout("reflowable"),
      manifest: `<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>`,
      spine: `<itemref idref="c" properties="rend:layout-pre-paginated"/>`,
      fixed: ["c"],
    },
    {
      name: "an aliased layout property",
      metadata: '<meta property="rend:layout">pre-paginated</meta>',
      manifest: `<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>`,
      spine: `<itemref idref="c"/>`,
      fixed: ["c"],
    },
    {
      name: "a refined layout",
      metadata: '<meta property="rendition:layout" refines="#c">pre-paginated</meta>',
      manifest: `<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>`,
      spine: `<itemref idref="c"/>`,
      fixed: [],
    },
    {
      name: "a padded idref",
      metadata: layout("pre-paginated"),
      manifest: `<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>`,
      spine: `<itemref idref=" c "/>`,
      fixed: [],
    },
    {
      name: "a fallback loop",
      metadata: layout("pre-paginated"),
      manifest: `<item id="a" href="a.xhtml" media-type="application/xhtml+xml" fallback="b"/>
        <item id="b" href="b.xhtml" media-type="application/xhtml+xml" fallback="a"/>`,
      spine: `<itemref idref="a"/>`,
      fixed: ["a"],
    },
  ])("finds fixed-layout items in $name", ({ metadata, manifest, spine, fixed }) => {
    expect([...FixedLayout.fixedLayoutIds(opf(metadata, manifest, spine))]).toEqual(fixed);
  });

  it.each([
    { name: "no viewport", head: "<title>t</title>", body: "", ids: ["HTM-046"] },
    {
      name: "a repeated, invalid width",
      head: '<meta name="viewport" content="width=abc, width=100, height=100"/>',
      body: "",
      ids: ["HTM-059", "HTM-057"],
    },
    {
      name: "a second viewport",
      head: '<meta name="viewport" content="width=1,height=1"/><meta name="viewport" content="x"/>',
      body: "",
      ids: ["HTM-060a"],
    },
    {
      name: "a viewport in the body",
      head: "<title>t</title>",
      body: '<meta name="viewport" content="width=1"/>',
      ids: ["HTM-046", "HTM-056"],
    },
  ])("checks the viewport of $name", ({ head, body, ids }) => {
    const findings = FixedLayout.xhtmlFindings(xhtml(head, body), "c.xhtml", true);
    expect(findings.map((finding) => finding.id)).toEqual(ids);
  });
});
