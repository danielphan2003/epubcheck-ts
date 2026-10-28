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
