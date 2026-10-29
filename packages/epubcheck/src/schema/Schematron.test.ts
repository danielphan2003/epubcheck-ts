import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import * as Schematron from "./Schematron.ts";
import { sources } from "./sources.generated.ts";

const schematronFiles = Object.keys(sources).filter((path) => path.endsWith(".sch"));

describe("Schematron", () => {
  // Evaluation skips assertions whose expressions fail, so a rewrite bug would hide checks.
  it.each(schematronFiles)("compiles every expression in %s", (path) => {
    const parsed = Schematron.parse(sources[path] ?? "", path, (file) => sources[file]);
    if (Result.isFailure(parsed)) throw new Error(parsed.failure);
    // A schema in an unrecognized Schematron namespace parses to no patterns at all; included
    // fragments (a bare `pattern`) are not schemas.
    if (/<(?:\w+:)?schema[\s>]/.test(sources[path] ?? "")) {
      expect(parsed.success.patterns.length).toBeGreaterThan(0);
    }
    expect(Schematron.staticErrors(parsed.success)).toEqual([]);
  });
});

describe("Schematron.validate", () => {
  const SCHEMA = `<schema xmlns="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
    <pattern><rule context="t"><assert test="normalize-space()">empty</assert></rule></pattern>
    <pattern><rule context="i"><assert test="normalize-space(@v) = 'a'">not a</assert></rule></pattern>
  </schema>`;
  // XPath's whitespace is space, tab, CR and LF only; NBSP and U+3000 are content. Rules fire in
  // one pass in document order across patterns, as the jar's console output shows.
  it.each([
    { name: "a space-only title", instance: "<r><t> \t\n</t></r>", messages: ["empty"] },
    { name: "an NBSP-only title", instance: "<r><t>\u00a0</t></r>", messages: [] },
    { name: "a padded attribute", instance: "<r><i v=' a\t'/></r>", messages: [] },
    { name: "an NBSP-padded attribute", instance: "<r><i v='a\u3000'/></r>", messages: ["not a"] },
    {
      name: "patterns matching out of order",
      instance: "<r><i v='b'/><t/><i v='c'/></r>",
      messages: ["not a", "empty", "not a"],
    },
  ])("checks $name", ({ instance, messages }) => {
    const schema = Schematron.parse(SCHEMA, "test.sch", () => undefined);
    const document = Xml.parse(instance);
    if (Result.isFailure(schema) || Result.isFailure(document)) throw new Error("bad fixture");
    const errors = Schematron.validate(schema.success, document.success, "file:///test.xml");
    expect(errors.map((error) => error.message)).toEqual(messages);
  });
});
