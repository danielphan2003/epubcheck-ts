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
      name: "an item without an ID in META-INF",
      parts: { manifest: '<item href="../META-INF/x.png" media-type="image/png"/>' },
      ids: [],
    },
    {
      name: "a link to a missing file that only an item with a fragment names",
      parts: { metadata: link("y.png"), manifest: item("y.png#f") },
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

describe("PackageChecks guide", () => {
  const pkg = (guide: string, version: string) =>
    `<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="id"><metadata/><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="css" href="s.css" media-type="text/css"/><item id="svg" href="s.svg" media-type="image/svg+xml"/><item id="r" href="https://example.org/r.mp3" media-type="audio/mpeg"/></manifest><spine><itemref idref="c"/></spine><guide>${guide}</guide></package>`;
  const reference = (href: string) => `<reference type="text" title="t" href="${href}"/>`;
  const files = new Set(["EPUB/package.opf", "EPUB/c.xhtml", "EPUB/s.css", "EPUB/s.svg"]);
  // Each row was checked against EPUBCheck 5.4.0 on a packaged EPUB, or alone with `--mode opf`.
  it.each([
    {
      name: "a missing file",
      guide: reference("missing.xhtml#x"),
      found: ["OPF-031 EPUB/missing.xhtml#x"],
    },
    { name: "a style sheet", guide: reference("s.css#y"), found: ["OPF-032 EPUB/s.css#y"] },
    {
      name: "an SVG document in EPUB 2",
      guide: reference("s.svg"),
      version: "2",
      found: ["OPF-032 EPUB/s.svg"],
    },
    { name: "an SVG document in EPUB 3", guide: reference("s.svg"), found: [] },
    { name: "the package document", guide: reference(""), found: ["OPF-031 EPUB/package.opf"] },
    { name: "a query", guide: reference("c.xhtml?q"), found: [] },
    {
      name: "a query after an absolute URL",
      guide: reference("https://example.org/x.xhtml") + reference("c.xhtml?q"),
      found: ["OPF-031 https://example.org/x.xhtml", "OPF-031 EPUB/c.xhtml?q"],
    },
    {
      name: "a missing file, checked alone",
      guide: reference("missing.xhtml"),
      alone: true,
      found: [],
    },
  ] as const)("reports $name", ({ guide, found, ...row }) => {
    const version = "version" in row ? row.version : "3";
    const document = Xml.parse(pkg(guide, version));
    if (Result.isFailure(document)) throw new Error(document.failure.message);
    const findings = PackageChecks.check({
      document: document.success,
      opf: PackageDocument.read(document.success, "EPUB/package.opf", version),
      container: "alone" in row ? undefined : files,
    });
    expect(
      findings
        .filter((finding) => finding.id === "OPF-031" || finding.id === "OPF-032")
        .map((finding) => `${finding.id} ${finding.args.join(" ")}`),
    ).toEqual(found);
  });
});
