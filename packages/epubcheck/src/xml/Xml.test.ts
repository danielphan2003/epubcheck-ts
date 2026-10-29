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
