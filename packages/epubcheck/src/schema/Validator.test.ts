import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import * as Datatypes from "./Datatypes.ts";
import * as Grammar from "./Grammar.ts";
import { SchemaValidator } from "./Validator.ts";
import * as XsdRegex from "./XsdRegex.ts";

const SCHEMA = `
default namespace = "urn:test"
datatypes xsd = "http://www.w3.org/2001/XMLSchema-datatypes"
start = element package { attribute version { "3.0" }, attribute id { xsd:NCName }?, metadata, manifest, spine, guide? }
metadata = element metadata { element title { xsd:token { minLength = "1" } }+ & element date { text }? }
manifest = element manifest { element item { attribute href { text } }* }
spine = element spine { attribute toc { text }, element itemref { empty }+ }
guide = element guide {
  (element label { empty } | element span { attribute for { text } | attribute ref { text } }),
  element list { (element dt { empty }, element dd { empty })* }?
}
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
    {
      name: "an element before a missing choice, resuming after the choice",
      instance: wrap(`${VALID_BODY}<guide><list/></guide>`),
      errors: ['element "list" not allowed yet; expected element "label" or "span"'],
    },
    {
      name: "an element after the resumed position",
      instance: wrap(`${VALID_BODY}<guide><list/><label/></guide>`),
      errors: [
        'element "list" not allowed yet; expected element "label" or "span"',
        'element "label" not allowed here; expected the element end-tag',
      ],
    },
    {
      name: "an element allowed later where the parent may also end",
      instance: wrap(`${VALID_BODY}<guide><label/><list><dd/></list></guide>`),
      errors: ['element "dd" not allowed yet; expected the element end-tag or element "dt"'],
    },
    {
      name: "a missing attribute from a choice",
      instance: wrap(`${VALID_BODY}<guide><span/></guide>`),
      errors: [
        'element "span" missing one or more required attributes; expected attribute "for" or "ref"',
      ],
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

describe("Datatypes", () => {
  const context = { resolve: () => undefined };
  const libraries = { whattf: () => undefined };
  // Each verdict was checked against EPUBCheck 5.4.0 on a manifest `href`.
  it.each([
    { name: "anyURI", value: "../a b.xhtml", valid: true },
    { name: "anyURI", value: "a[1]", valid: false },
    { name: "anyURI", value: "a?b[1]#c[2]", valid: true },
    { name: "anyURI", value: "x:y[0]", valid: true },
    { name: "anyURI", value: "x:/a[1]", valid: false },
    { name: "anyURI", value: "http://[::1]:80/a", valid: true },
    { name: "anyURI", value: "http://[x/a", valid: false },
    { name: "anyURI", value: "foo:", valid: false },
    { name: "anyURI", value: "foo:#a", valid: false },
    { name: "anyURI", value: "1x:foo", valid: false },
    { name: "anyURI", value: "a#b#c", valid: false },
    { name: "anyURI", value: "na%zzv.xhtml", valid: false },
    { name: "NMTOKENS", value: "a b", valid: true },
    { name: "NMTOKENS", value: "", valid: false },
  ])("decides xsd:$name $value", ({ name, value, valid }) => {
    const datatype = Datatypes.lookup(Datatypes.XSD_LIBRARY, name, [], libraries);
    expect(datatype?.validate(value, context) === undefined).toBe(valid);
  });
});
