import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import * as PackageChecks from "./PackageChecks.ts";
import * as PackageDocument from "./PackageDocument.ts";

const opf = (itemref: string) => `<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata/>
  <manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine>${itemref}</spine>
</package>`;

describe("PackageChecks", () => {
  // The reference looks up the trimmed `idref`, quotes it as written, and leaves a missing one
  // to the schema.
  it.each([
    { itemref: "<itemref/>", args: [] },
    { itemref: '<itemref idref=""/>', args: [""] },
    { itemref: '<itemref idref="  x  "/>', args: ["  x  "] },
    { itemref: '<itemref idref=" c "/>', args: [] },
  ])("reports OPF-049 for $itemref", ({ itemref, args }) => {
    const document = Xml.parse(opf(itemref));
    if (Result.isFailure(document)) throw new Error(document.failure.message);
    const findings = PackageChecks.check({
      document: document.success,
      opf: PackageDocument.read(document.success, "package.opf", "3"),
      container: undefined,
    });
    expect(
      findings.filter((finding) => finding.id === "OPF-049").flatMap((finding) => finding.args),
    ).toEqual(args);
  });
});

describe("PackageChecks URLs", () => {
  const pkg = (parts: { metadata?: string; manifest?: string; guide?: string }, version: string) =>
    `<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${parts.metadata ?? ""}</metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>${parts.manifest ?? ""}</manifest><spine><itemref idref="c"/></spine>${parts.guide ?? ""}</package>`;
  const item = (href: string) => `<item id="i" href="${href}" media-type="image/png"/>`;
  const link = (href: string) => `<link rel="record" href="${href}" media-type="application/xml"/>`;
  const files = new Set(["EPUB/package.opf", "EPUB/c.xhtml", "EPUB/x.png", "EPUB/onix.xml"]);
  const ids = new Set(["RSC-020", "RSC-026", "RSC-030", "RSC-033", "RSC-007w", "PKG-025"]);
  // Each row was checked against EPUBCheck 5.4.0 on a packaged EPUB, or alone with `--mode opf`.
  it.each([
    { name: "a query", parts: { manifest: item("x.png?v=1") }, ids: ["RSC-033"] },
    {
      name: "a query after an absolute URL",
      parts: { metadata: link("https://example.org/r.xml"), manifest: item("x.png?v=1") },
      ids: [],
    },
    { name: "a protocol-relative URL", parts: { manifest: item("//example.org/x.png") }, ids: [] },
    {
      name: "a path out of the container",
      parts: { manifest: item("../../x.png") },
      ids: ["RSC-026"],
    },
    {
      name: "a guide reference out of the container",
      parts: { guide: '<guide><reference type="text" href="../../c.xhtml"/></guide>' },
      ids: ["RSC-026"],
    },
    {
      name: "an absolute path, checked alone",
      parts: { manifest: item("/abs/x.png") },
      alone: true,
      ids: [],
    },
    { name: "a backslash", parts: { manifest: item("sub\\x.png") }, ids: ["RSC-020"] },
    { name: "an uppercase file scheme", parts: { metadata: link("FILE:///onix.xml") }, ids: [] },
    {
      name: "an EPUB 3 item in META-INF",
      parts: { manifest: item("../META-INF/x.png") },
      ids: ["PKG-025"],
    },
    {
      name: "an EPUB 2 item in META-INF",
      parts: { manifest: item("../META-INF/x.png") },
      version: "2",
      ids: [],
    },
    {
      name: "a link to a missing file",
      parts: { metadata: link("missing.xml") },
      ids: ["RSC-007w"],
    },
    {
      name: "a link to a declared item that is missing",
      parts: { metadata: link("y.png"), manifest: item("y.png") },
      ids: [],
    },
    {
      name: "a link with a fragment to an undeclared file",
      parts: { metadata: link("onix.xml#f") },
      ids: ["RSC-007w"],
    },
  ] as const)("reports $name", ({ parts, ...row }) => {
    const version = "version" in row ? row.version : "3";
    const document = Xml.parse(pkg(parts, version));
    if (Result.isFailure(document)) throw new Error(document.failure.message);
    const findings = PackageChecks.check({
      document: document.success,
      opf: PackageDocument.read(document.success, "EPUB/package.opf", version),
      container: "alone" in row ? undefined : files,
    });
    expect(findings.map((finding) => finding.id).filter((id) => ids.has(id))).toEqual(row.ids);
  });
});
