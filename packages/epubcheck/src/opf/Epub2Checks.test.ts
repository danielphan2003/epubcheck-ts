import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import * as Epub2Checks from "./Epub2Checks.ts";
import * as PackageChecks from "./PackageChecks.ts";
import * as PackageDocument from "./PackageDocument.ts";

const pkg = (
  parts: { metadata?: string; manifest?: string; spine?: string; itemrefs?: string },
  version: string,
) =>
  `<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="id"><metadata><dc:identifier id="id">x</dc:identifier>${parts.metadata ?? ""}</metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>${parts.manifest ?? ""}</manifest><spine${parts.spine ?? ""}><itemref idref="c"/>${parts.itemrefs ?? ""}</spine></package>`;
const item = (id: string, type: string, extra = "") =>
  `<item id="${id}" href="${id}.x" media-type="${type}"${extra}/>`;
const itemref = (idref: string) => `<itemref idref="${idref}"/>`;
const ids = new Set(["OPF-035", "OPF-037", "OPF-042", "OPF-043", "OPF-044"]);

describe("Epub2Checks", () => {
  // Each row was checked against EPUBCheck 5.4.0.
  it.each([
    {
      name: "an image with a fallback in the spine",
      parts: { manifest: item("p", "image/png", ' fallback="c"'), itemrefs: itemref("p") },
      found: ["OPF-042"],
    },
    {
      name: "an image listed twice in the spine",
      parts: { manifest: item("p", "image/png"), itemrefs: itemref("p") + itemref("p") },
      found: ["OPF-042", "OPF-042"],
    },
    {
      name: "a style sheet in the spine",
      parts: { manifest: item("s", "text/css"), itemrefs: itemref("s") },
      found: ["OPF-042"],
    },
    {
      name: "a foreign item without a fallback",
      parts: { manifest: item("f", "application/pdf"), itemrefs: itemref("f") },
      found: ["OPF-043"],
    },
    {
      name: "a foreign item whose chain reaches no content document",
      parts: {
        manifest: item("f", "application/pdf", ' fallback="g"') + item("g", "application/pdf"),
        itemrefs: itemref("f"),
      },
      found: ["OPF-044"],
    },
    {
      name: "a foreign item with an HTML fallback",
      parts: {
        manifest: item("f", "application/pdf", ' fallback="h"') + item("h", "text/html"),
        itemrefs: itemref("f"),
      },
      found: ["OPF-035"],
    },
    {
      name: "a foreign item with a fallback style sheet",
      parts: {
        manifest:
          item("f", "application/pdf", ' fallback="g" fallback-style="s"') +
          item("g", "application/pdf") +
          item("s", "text/css"),
        itemrefs: itemref("f"),
      },
      found: [],
    },
    {
      name: "deprecated types",
      parts: { manifest: item("h", "text/html") + item("o", "text/x-oeb1-document") },
      found: ["OPF-035", "OPF-037"],
    },
    {
      name: "a deprecated type with a parameter",
      parts: { manifest: item("h", "text/html; charset=utf-8") },
      found: [],
    },
  ] as const)("reports $name", ({ parts, found }) => {
    const version = "2";
    const document = Xml.parse(pkg(parts, version));
    if (Result.isFailure(document)) throw new Error(document.failure.message);
    const context = {
      document: document.success,
      opf: PackageDocument.read(document.success, "EPUB/package.opf", version),
      container: undefined,
    };
    const findings = [...PackageChecks.check(context), ...Epub2Checks.check(context)];
    expect(findings.map((finding) => finding.id).filter((id) => ids.has(id))).toEqual(found);
  });
});
