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
