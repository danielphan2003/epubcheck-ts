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
  ])("reports $name", ({ source, error }) => {
    const parsed = Xml.parse(source);
    expect(Result.isFailure(parsed) && parsed.failure).toEqual(error);
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
