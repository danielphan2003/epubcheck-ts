import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "./Xml.ts";

describe("Xml.parse", () => {
  // Xerces expands character references when an entity is declared, and references in the
  // replacement text when it is used.
  it.each([
    { name: "a character reference", subset: '<!ENTITY v "&#51;.0">', body: "&v;", text: "3.0" },
    {
      name: "a nested entity",
      subset: '<!ENTITY a "&#65;"><!ENTITY b "&a;B">',
      body: "&b;",
      text: "AB",
    },
    { name: "a re-parsed reference", subset: '<!ENTITY r "&#38;#51;">', body: "&r;", text: "3" },
    { name: "a predefined entity", subset: '<!ENTITY p "&amp;lt;">', body: "&p;", text: "&lt;" },
    {
      name: "the first declaration",
      subset: '<!ENTITY d "1"><!ENTITY d "2">',
      body: "&d;",
      text: "1",
    },
  ])("expands $name", ({ subset, body, text }) => {
    const parsed = Xml.parse(`<!DOCTYPE r [${subset}]><r>${body}</r>`);
    expect(Result.isSuccess(parsed) && Xml.textContent(parsed.success.root)).toBe(text);
  });
});

// Each position is where EPUBCheck 5.4.0 reports HTM-004 and HTM-003.
describe("Xml.parse doctype", () => {
  it.each([
    {
      name: "a public ID",
      doctype: '<!DOCTYPE html PUBLIC "a" "b">',
      at: [1, 30],
      entities: [],
    },
    {
      name: "an internal subset",
      doctype:
        '<!DOCTYPE html SYSTEM "b" [\n<!ENTITY e SYSTEM "e.txt">\n<!ENTITY % p PUBLIC "x" "p">\n]>',
      at: [1, 27],
      entities: [
        ["e", 2, 27],
        ["%p", 3, 29],
      ],
    },
    {
      name: "declarations in comments and literals",
      doctype:
        '<!DOCTYPE html [\n<!-- <!ENTITY c SYSTEM "c"> -->\n<!ENTITY v "<!ENTITY w SYSTEM \'w\'>">\n]>',
      at: [1, 16],
      entities: [],
    },
    {
      name: "a comment and CRLF line ends first",
      doctype: '<!-- c -->\r\n<!DOCTYPE html SYSTEM "b" [\r\n<!ENTITY e SYSTEM "e.txt">\r\n]>',
      at: [2, 27],
      entities: [["e", 3, 27]],
    },
    {
      name: "an unparsed entity",
      doctype: '<!DOCTYPE html [\n<!ENTITY n SYSTEM "n.png" NDATA png>\n]>',
      at: [1, 16],
      entities: [],
    },
  ])("locates $name", ({ doctype, at, entities }) => {
    const parsed = Xml.parse(`${doctype}<html/>`);
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    const found = parsed.success.doctype;
    expect([found?.line, found?.column]).toEqual(at);
    expect(found?.externalEntities.map(({ name, line, column }) => [name, line, column])).toEqual(
      entities,
    );
  });
});

describe("Xml.parse errors", () => {
  // Xerces' messages and positions, which upstream reports as RSC-016.
  it.each([
    {
      name: "a bare ampersand in a value",
      source: '<!DOCTYPE r [<!ENTITY x "a & b">]><r>&x;</r>',
      error: {
        message: "The entity name must immediately follow the '&' in the entity reference.",
        line: 1,
        column: 29,
      },
    },
    {
      name: "an unterminated reference in a value",
      source: '<!DOCTYPE r [<!ENTITY x "&nope">]><r/>',
      error: {
        message: "The reference to entity \"nope\" must end with the ';' delimiter.",
        line: 1,
        column: 31,
      },
    },
    {
      name: "an invalid character reference in a value",
      source: '<!DOCTYPE r [<!ENTITY x "&#1;">]><r/>',
      error: {
        message: 'Character reference "&#1" is an invalid XML character.',
        line: 1,
        column: 30,
      },
    },
    {
      name: "an undeclared nested entity",
      source: '<!DOCTYPE r [<!ENTITY x "&nope;">]><r>&x;</r>',
      error: {
        message: 'The entity "nope" was referenced, but not declared.',
        line: 1,
        column: 42,
      },
    },
    {
      name: "a recursive entity",
      source: '<!DOCTYPE r [<!ENTITY a "&b;"><!ENTITY b "&a;">]><r>&a;</r>',
      error: {
        message: 'Recursive entity reference "a". (Reference path: a -> b -> a),',
        line: 1,
        column: 56,
      },
    },
    {
      name: "a public identifier without a system literal",
      source: '<!DOCTYPE r PUBLIC "p"><r/>',
      error: {
        message: "White spaces are required between publicId and systemId.",
        line: 1,
        column: 23,
      },
    },
    {
      name: "an unsupported version, spaced out",
      source: '<?xml  version = "1.5"?><r/>',
      error: {
        message: 'XML version "1.5" is not supported, only XML 1.0 is supported.',
        line: 1,
        column: 20,
      },
    },
    {
      name: "an unsupported version after a line break",
      source: '<?xml\nversion="1.5"?><r/>',
      error: {
        message: 'XML version "1.5" is not supported, only XML 1.0 is supported.',
        line: 1,
        column: 20,
      },
    },
    {
      name: "an unsupported version scanned as XML 1.1",
      source: '<?xml version="1.10"?><r/>',
      error: {
        message: 'XML version "1.10" is not supported, only XML 1.0 and XML 1.1 are supported.',
        line: 1,
        column: 21,
      },
    },
    {
      name: "a malformed version before a malformed declaration",
      source: '<?xml version="abc" standalone="maybe"?><r/>',
      error: {
        message: 'XML version "abc" is not supported, only XML 1.0 is supported.',
        line: 1,
        column: 20,
      },
    },
  ])("reports $name", ({ source, error }) => {
    const parsed = Xml.parse(source);
    expect(Result.isFailure(parsed) && parsed.failure).toEqual(error);
  });

  // Upstream reports the version (HTM-001) once the root's start tag is read.
  it.each([
    { name: "inside the root start tag", source: '<?xml version="1.1"?><r a="1" a="2"/>' },
    { name: "after the root start tag", source: '<?xml version="1.1"?><r><x></r>', version: "1.1" },
  ])("keeps the version of a failure $name", ({ source, version }) => {
    const parsed = Xml.parse(source);
    expect(Result.isFailure(parsed) && parsed.failure.version).toBe(version);
  });
});

describe("Xml.decodeDocument", () => {
  const bytes = (...values: ReadonlyArray<number | string>) =>
    new Uint8Array(
      values.flatMap((value) =>
        typeof value === "number" ? [value] : [...new TextEncoder().encode(value)],
      ),
    );
  const declaration = (encoding: string) => `<?xml version="1.0" encoding=${encoding}?><r/>`;
  // Each answer is EPUBCheck 5.4.0's: the encoding it reports (RSC-027, RSC-028) and the error
  // Xerces raises (RSC-016).
  it.each([
    { name: "no declaration", input: bytes("<r/>"), encoding: "UTF-8", error: undefined },
    {
      name: "a UTF-8 BOM",
      input: bytes(0xef, 0xbb, 0xbf, "<r/>"),
      encoding: "UTF-8",
      error: undefined,
    },
    {
      name: "a declared Latin-1",
      input: bytes(declaration('"ISO-8859-1"')),
      encoding: "ISO-8859-1",
      error: undefined,
    },
    {
      name: "a lowercase name",
      input: bytes(declaration("'windows-1252'")),
      encoding: "WINDOWS-1252",
      error: undefined,
    },
    // Upstream looks for a literal `encoding=` and reads the document as UTF-8 otherwise.
    {
      name: "spaces around `=`",
      input: bytes('<?xml version="1.0" encoding = "ISO-8859-1"?><r/>'),
      encoding: "UTF-8",
      error: undefined,
    },
    {
      name: "a name Xerces rejects",
      input: bytes(declaration('"UTF8"')),
      encoding: "UTF8",
      error: 'Invalid encoding name "UTF8".',
    },
    // Xerces decodes ASCII strictly, under any of its names.
    {
      name: "non-ASCII bytes declared ASCII",
      input: bytes(declaration('"us-ascii"'), 0xe9),
      encoding: "US-ASCII",
      error: 'Byte "233" is not a member of the (7-bit) ASCII character set.',
    },
    {
      name: "an ASCII alias",
      input: bytes(declaration('"ISO646-US"')),
      encoding: "ISO646-US",
      error: undefined,
    },
    {
      name: "single-byte text declaring UTF-16",
      input: bytes(declaration('"UTF-16"')),
      encoding: "UTF-16",
      error: "Content is not allowed in prolog.",
    },
    {
      name: "a UTF-16 BOM",
      input: bytes(0xff, 0xfe, 0x3c, 0x00, 0x72, 0x00, 0x2f, 0x00, 0x3e, 0x00),
      encoding: "UTF-16",
      error: undefined,
    },
    // The UTF-16 patterns come first, so this UCS-4 BOM is reported as UTF-16.
    {
      name: "FF FE 00 00",
      input: bytes(0xff, 0xfe, 0x00, 0x00, 0x3c, 0x00),
      encoding: "UTF-16",
      error: undefined,
    },
    // Without a BOM, UTF-16 is recognized only from `<?`.
    {
      name: "BOM-less UTF-16",
      input: bytes(
        0x3c,
        0x00,
        0x3f,
        0x00,
        0x78,
        0x00,
        0x6d,
        0x00,
        0x6c,
        0x00,
        0x3f,
        0x00,
        0x3e,
        0x00,
        0x3c,
        0x00,
        0x72,
        0x00,
        0x2f,
        0x00,
        0x3e,
        0x00,
      ),
      encoding: "UTF-16",
      error: undefined,
    },
    {
      name: "BOM-less UTF-16 without a declaration",
      input: bytes(0x3c, 0x00, 0x72, 0x00, 0x2f, 0x00, 0x3e, 0x00),
      encoding: "UTF-8",
      error: undefined,
    },
  ])("sniffs $name", ({ input, encoding, error }) => {
    const decoded = Xml.decodeDocument(input);
    expect(decoded.encoding).toBe(encoding);
    expect(decoded.error?.message).toBe(error);
  });

  it("locates encoding errors just past the declaration", () => {
    const decoded = Xml.decodeDocument(new TextEncoder().encode(declaration('"foo-bar"')));
    expect(decoded.error).toEqual({
      message: 'Invalid encoding name "foo-bar".',
      line: 1,
      column: 41,
    });
  });
});
