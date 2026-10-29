import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import * as PackageDocument from "./PackageDocument.ts";

describe("PackageDocument.read pagination source", () => {
  // Each row's verdict is EPUBCheck 5.4.0's (OPF-066 when false) for an EDUPUB publication with
  // page breaks, a `dc:source id="src"`, and this `meta`.
  it.each([
    { meta: '<meta property="source-of" refines="#src">pagination</meta>', found: true },
    { meta: '<meta property="source-of" refines="src">pagination</meta>', found: true },
    { meta: '<meta property="source-of" refines="#src">  pagination\n</meta>', found: true },
    { meta: "", found: false },
    { meta: '<meta property="source-of" refines="#">pagination</meta>', found: false },
    { meta: '<meta property="source-of" refines="#src">other</meta>', found: false },
    { meta: '<meta property="source-of" refines="#title">pagination</meta>', found: false },
  ])("finds $found for $meta", ({ meta, found }) => {
    const document = Xml.parse(
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title id="title">T</dc:title><dc:source id="src">S</dc:source>${meta}</metadata><manifest/><spine/></package>`,
    );
    if (Result.isFailure(document)) throw new Error(document.failure.message);
    const opf = PackageDocument.read(document.success, "package.opf", "3");
    expect(opf.metadata.paginationSource).toBe(found);
  });
});
