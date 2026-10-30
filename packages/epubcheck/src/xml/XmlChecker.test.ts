import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "./Xml.ts";
import * as XmlChecker from "./XmlChecker.ts";

const SVG11 = '"-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"';
const NCX = '"-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd"';
const XHTML11 = '"-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"';

describe("XmlChecker.declarationFindings", () => {
  // Each row is what EPUBCheck 5.4.0 reports for an EPUB 3 resource of that type.
  it.each([
    {
      name: "the SVG identifiers on SVG",
      doctype: `<!DOCTYPE svg PUBLIC ${SVG11}>`,
      mediaType: "image/svg+xml",
      found: [],
    },
    {
      name: "only a system identifier",
      doctype: '<!DOCTYPE svg SYSTEM "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
      mediaType: "image/svg+xml",
      found: ["OPF-073"],
    },
    {
      name: "the NCX identifiers on SVG",
      doctype: `<!DOCTYPE svg PUBLIC ${NCX}>`,
      mediaType: "image/svg+xml",
      found: ["OPF-073"],
    },
    {
      name: "the NCX identifiers on an NCX",
      doctype: `<!DOCTYPE ncx PUBLIC ${NCX}>`,
      mediaType: "application/x-dtbncx+xml",
      found: [],
    },
    {
      name: "a META-INF file",
      doctype: '<!DOCTYPE encryption PUBLIC "-//X//DTD x//EN" "http://example.org/x.dtd">',
      mediaType: "application/xml",
      found: ["OPF-073"],
    },
    // An XHTML document's `html` DOCTYPE is HTM-004's, whatever its case; another root is not.
    {
      name: "an XHTML 1.1 DOCTYPE",
      doctype: `<!DOCTYPE HTML PUBLIC ${XHTML11}>`,
      mediaType: "application/xhtml+xml",
      found: ["HTM-004"],
    },
    {
      name: "another XHTML root",
      doctype: `<!DOCTYPE foo PUBLIC ${XHTML11}>`,
      mediaType: "application/xhtml+xml",
      found: ["OPF-073"],
    },
    {
      name: "the legacy compatibility DOCTYPE",
      doctype: '<!DOCTYPE html SYSTEM "about:legacy-compat">',
      mediaType: "application/xhtml+xml",
      found: [],
    },
    // Xerces collapses the spaces in a public ID.
    {
      name: "a spaced public ID",
      doctype:
        '<!DOCTYPE svg PUBLIC "  -//W3C//DTD   SVG 1.1//EN " "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
      mediaType: "image/svg+xml",
      found: [],
    },
    {
      name: "an external entity",
      doctype: '<!DOCTYPE smil [<!ENTITY e SYSTEM "e.txt">]>',
      mediaType: "application/smil+xml",
      found: ["HTM-003"],
    },
  ])("reports $name", ({ doctype, mediaType, found }) => {
    const parsed = Xml.parse(`${doctype}<r/>`);
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    const declared = parsed.success.doctype;
    if (declared === undefined) throw new Error("no DOCTYPE");
    const findings = XmlChecker.declarationFindings(declared, "EPUB/r.xml", mediaType);
    expect(findings.map(({ id }) => id)).toEqual(found);
  });
});
