import { describe, expect, it } from "@effect/vitest";

import * as Vocabularies from "./Vocabularies.ts";

describe("Vocabularies.parsePrefixes", () => {
  // Each answer is EPUBCheck 5.4.0's for the package document's `prefix` attribute.
  it.each([
    { value: "foaf: http://xmlns.com/foaf/spec/", ids: [], declared: ["foaf"] },
    {
      value: " foaf: http://xmlns.com/foaf/spec/ ",
      ids: ["OPF-004", "OPF-004"],
      declared: ["foaf"],
    },
    { value: "foaf:", ids: ["OPF-005"], declared: [] },
    { value: "a: http://a/ b", ids: ["OPF-005"], declared: ["a"] },
    { value: "a:http://a/ b: http://b/", ids: ["OPF-004d"], declared: ["b"] },
    { value: "a b: http://b/", ids: ["OPF-004c", "OPF-006", "OPF-004d"], declared: [] },
    { value: "xsd: http://www.w3.org/2001/XMLSchema#", ids: ["OPF-086c"], declared: ["xsd"] },
  ])("parses $value", ({ value, ids, declared }) => {
    const parsed = Vocabularies.parsePrefixes(value);
    expect(parsed.problems.map((problem) => problem.id)).toEqual(ids);
    // A declaration replaces the reserved vocabulary with a new entry.
    const mapped = [...parsed.vocabs].filter(
      ([prefix, vocab]) => vocab !== Vocabularies.RESERVED[prefix],
    );
    expect(mapped.map(([prefix]) => prefix)).toEqual(declared);
  });
});
