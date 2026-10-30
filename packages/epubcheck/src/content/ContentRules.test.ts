import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import * as ContentRules from "./ContentRules.ts";

describe("ContentRules.schemeFindings", () => {
  const document = (head: string, body: string) =>
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:svg="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><head><title>t</title>${head}</head><body><p>${body}</p></body></html>`;
  const svg = (link: string) => `<svg:svg><svg:a ${link}><svg:text>t</svg:text></svg:a></svg:svg>`;
  // Each count was checked against EPUBCheck 5.4.0 on a single XHTML document.
  it.each([
    { name: "an unregistered scheme", body: '<a href="foo:x">a</a>', warned: 1 },
    { name: "a registered scheme", body: '<a href="HTTP://example.org/">a</a>', warned: 0 },
    { name: "a trailing no-break space", body: '<a href="foo:x&#160;">a</a>', warned: 1 },
    { name: "a leading no-break space", body: '<a href="&#160;foo:x">a</a>', warned: 0 },
    { name: "a leading em space", body: '<a href="&#x2003;foo:x">a</a>', warned: 1 },
    { name: "an out-of-range port", body: '<a href="ws://x:99999/">a</a>', warned: 1 },
    { name: "a non-digit port", body: '<a href="ws://x:abc/">a</a>', warned: 0 },
    {
      name: "an image map area",
      body: '<map name="m"><area href="foo:x" alt="a"/></map>',
      warned: 1,
    },
    {
      name: "a relative link under a remote base",
      head: '<base href="ws://example.org/"/>',
      body: '<a href="y">a</a>',
      warned: 1,
    },
    {
      name: "a relative link under a base of another scheme",
      head: '<base href="foo:/x/"/>',
      body: '<a href="y">a</a>',
      warned: 0,
    },
    {
      name: "a relative link under a base after a no-break space",
      head: '<base href="&#160;ws://example.org/"/>',
      body: '<a href="y">a</a>',
      warned: 0,
    },
    {
      name: "a link of the base's scheme, resolved against it",
      head: '<base href="ws://example.org/a/b"/>',
      body: '<a href="ws:#f">a</a>',
      warned: 1,
    },
    {
      name: "a relative link after an earlier element's xml:base",
      body: '<span xml:base="ws://example.org/">s</span><a href="y">a</a>',
      warned: 1,
    },
    { name: "an uppercase element name", body: '<A href="foo:x">a</A>', warned: 1 },
    { name: "an SVG href", body: svg('href="foo:x"'), warned: 1 },
    { name: "an SVG href in EPUB 2", body: svg('href="foo:x"'), version: "2", warned: 0 },
    {
      name: "an SVG xlink:href in EPUB 2",
      body: svg('xlink:href="foo:x"'),
      version: "2",
      warned: 1,
    },
  ] as const)("decides $name", ({ body, warned, ...row }) => {
    const parsed = Xml.parse(document("head" in row ? row.head : "", body));
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    const version = "version" in row ? row.version : "3";
    expect(ContentRules.schemeFindings(parsed.success, "a.xhtml", version)).toHaveLength(warned);
  });
});

describe("ContentRules.check links", () => {
  const ids = new Set(["CSS-005", "OPF-026", "OPF-028"]);
  // Each row was checked against EPUBCheck 5.4.0 on a single XHTML document.
  it.each([
    {
      name: "a repeated prefixed class",
      link: '<link rel="stylesheet" href="a.css" class="x:a x:a"/>',
      ids: ["OPF-028", "OPF-028"],
    },
    {
      name: "a class without a prefix name",
      link: '<link rel="stylesheet" href="a.css" class=":b"/>',
      ids: ["OPF-026"],
    },
    {
      name: "a reserved content prefix",
      link: '<link rel="stylesheet" href="a.css" class="msv:a"/>',
      ids: ["OPF-028"],
    },
    {
      name: "a prefixed class beside conflicting tags",
      link: '<link rel="stylesheet" href="a.css" class="y:day night day"/>',
      ids: ["OPF-028", "CSS-005"],
    },
    {
      name: "an uppercase element",
      link: '<LINK rel="stylesheet" href="a.css" class="day night z:a"/>',
      ids: [],
    },
  ])("reports $name", ({ link, ids: expected }) => {
    const parsed = Xml.parse(
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" epub:prefix="x: http://example.org/x#"><head><title>t</title>${link}</head><body><p>x</p></body></html>`,
    );
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    const findings = ContentRules.check(parsed.success, "a.xhtml", "xhtml");
    expect(findings.map((finding) => finding.id).filter((id) => ids.has(id))).toEqual(expected);
  });
});
