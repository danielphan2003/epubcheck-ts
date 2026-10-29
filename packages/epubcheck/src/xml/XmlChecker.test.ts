import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "./Xml.ts";
import * as XmlChecker from "./XmlChecker.ts";

const SVG11 = '"-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"';
const NCX = '"-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd"';

describe("XmlChecker.externalIdentifiers", () => {
  // Each row is what EPUBCheck 5.4.0 reports (OPF-073) for an EPUB 3 resource of that type.
  it.each([
    {
      name: "the SVG identifiers on SVG",
      doctype: `<!DOCTYPE svg PUBLIC ${SVG11}>`,
      mediaType: "image/svg+xml",
      found: 0,
    },
    {
      name: "only a system identifier",
      doctype: '<!DOCTYPE svg SYSTEM "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
      mediaType: "image/svg+xml",
      found: 1,
    },
    {
      name: "the NCX identifiers on SVG",
      doctype: `<!DOCTYPE svg PUBLIC ${NCX}>`,
      mediaType: "image/svg+xml",
      found: 1,
    },
    {
      name: "the NCX identifiers on an NCX",
      doctype: `<!DOCTYPE ncx PUBLIC ${NCX}>`,
      mediaType: "application/x-dtbncx+xml",
      found: 0,
    },
    {
      name: "a META-INF file",
      doctype: '<!DOCTYPE encryption PUBLIC "-//X//DTD x//EN" "http://example.org/x.dtd">',
      mediaType: "application/xml",
      found: 1,
    },
    {
      name: "no identifier",
      doctype: "<!DOCTYPE smil>",
      mediaType: "application/smil+xml",
      found: 0,
    },
  ])("reports $name", ({ doctype, mediaType, found }) => {
    const parsed = Xml.parse(`${doctype}<r/>`);
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    const findings = XmlChecker.externalIdentifiers(
      parsed.success.doctype,
      "EPUB/r.xml",
      mediaType,
    );
    expect(findings.map(({ id }) => id)).toEqual(Array.from({ length: found }, () => "OPF-073"));
  });
});
