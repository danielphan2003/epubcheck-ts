import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import * as Grammar from "./Grammar.ts";
import { SchemaValidator } from "./Validator.ts";
import * as XsdRegex from "./XsdRegex.ts";

const SCHEMA = `
default namespace = "urn:test"
datatypes xsd = "http://www.w3.org/2001/XMLSchema-datatypes"
start = element package { attribute version { "3.0" }, attribute id { xsd:NCName }?, metadata, manifest, spine }
metadata = element metadata { element title { xsd:token { minLength = "1" } }+ & element date { text }? }
manifest = element manifest { element item { attribute href { text } }* }
spine = element spine { attribute toc { text }, element itemref { empty }+ }
`;

const validate = (instance: string) => {
  const compiled = Grammar.compile(
    { read: (path) => (path === "test.rnc" ? SCHEMA : undefined) },
    "test.rnc",
    {
      whattf: () => undefined,
    },
  );
  if (Result.isFailure(compiled)) throw new Error(compiled.failure.join("; "));
  const document = Xml.parse(instance);
  if (Result.isFailure(document)) throw new Error(document.failure.message);
  return new SchemaValidator(compiled.success)
    .validate(document.success)
    .map((error) => error.message);
};

const wrap = (body: string, attributes = 'version="3.0"') =>
  `<package xmlns="urn:test" ${attributes}>${body}</package>`;
const VALID_BODY =
  "<metadata><title>T</title></metadata><manifest/><spine toc='x'><itemref/></spine>";

describe("SchemaValidator", () => {
  // Messages follow Jing's wording, which upstream reports verbatim in RSC-005.
  it.each([
    { name: "a valid document", instance: wrap(VALID_BODY), errors: [] },
    {
      name: "an element out of order, resuming after the missing one",
      instance: wrap(
        "<manifest/><metadata><title>T</title></metadata><spine toc='x'><itemref/></spine>",
      ),
      errors: [
        'element "manifest" not allowed yet; missing required element "metadata"',
        'element "metadata" not allowed here; expected element "spine"',
      ],
    },
    {
      name: "a missing required child",
      instance: wrap("<metadata><title>T</title></metadata><manifest/>"),
      errors: ['element "package" incomplete; missing required element "spine"'],
    },
    {
      name: "a missing required attribute",
      instance: wrap("<metadata><title>T</title></metadata><manifest/><spine><itemref/></spine>"),
      errors: ['element "spine" missing required attribute "toc"'],
    },
    {
      name: "an unknown element",
      instance: wrap(
        `<metadata><title>T</title></metadata><hello/><manifest/><spine toc="x"><itemref/></spine>`,
      ),
      errors: ['element "hello" not allowed anywhere; expected element "manifest"'],
    },
    {
      name: "an invalid attribute value",
      instance: wrap(VALID_BODY, 'version="2.0"'),
      errors: ['value of attribute "version" is invalid; must be equal to "3.0"'],
    },
    {
      name: "an invalid datatype value",
      instance: wrap(VALID_BODY, 'version="3.0" id="1x"'),
      errors: ['value of attribute "id" is invalid; must be an XML name without colons'],
    },
    {
      name: "an unexpected attribute",
      instance: wrap(VALID_BODY, 'version="3.0" lang="en"'),
      errors: ['attribute "lang" not allowed here; expected attribute "id"'],
    },
    {
      name: "empty character content",
      instance: wrap("<metadata><title/></metadata><manifest/><spine toc='x'><itemref/></spine>"),
      errors: [
        'character content of element "title" invalid; must be a string with length at least 1 (actual length was 0)',
      ],
    },
    {
      name: "a repeated element with the expected alternatives",
      instance: wrap(
        "<metadata><title>T</title><date/><date/></metadata><manifest/><spine toc='x'><itemref/></spine>",
      ),
      errors: ['element "date" not allowed here; expected the element end-tag or element "title"'],
    },
  ])("reports $name", ({ instance, errors }) => {
    expect(validate(instance)).toEqual(errors);
  });
});

describe("XsdRegex", () => {
  it.each([
    { pattern: "[a-z]+", value: "abc", matches: true },
    { pattern: "[a-z]+", value: "abc1", matches: false },
    { pattern: "[a-z-[aeiou]]+", value: "xyz", matches: true },
    { pattern: "[a-z-[aeiou]]+", value: "xa", matches: false },
    { pattern: "\\i\\c*", value: "_name-1", matches: true },
    { pattern: "\\i\\c*", value: "1name", matches: false },
    { pattern: "a^b$", value: "a^b$", matches: true },
    { pattern: "#.+", value: "#map", matches: true },
  ])("translates $pattern against $value", ({ pattern, value, matches }) => {
    expect(XsdRegex.compile(pattern)?.test(value)).toBe(matches);
  });
});
