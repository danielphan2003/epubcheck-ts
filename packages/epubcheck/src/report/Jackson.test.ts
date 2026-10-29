import { describe, expect, it } from "@effect/vitest";

import * as Jackson from "./Jackson.ts";

describe("Jackson.stringify", () => {
  // Expected output copied from upstream's JSON reports.
  it.each([
    {
      name: "empty containers",
      value: { messages: [], checker: {} },
      expected: '{\n  "messages" : [ ],\n  "checker" : { }\n}',
    },
    {
      name: "scalar arrays inline",
      value: {
        referencedItems: ["EPUB/a.xhtml", "EPUB/b.xhtml"],
        nSpines: 1,
        isLinear: true,
        media: null,
      },
      expected:
        '{\n  "referencedItems" : [ "EPUB/a.xhtml", "EPUB/b.xhtml" ],\n  "nSpines" : 1,\n  "isLinear" : true,\n  "media" : null\n}',
    },
    {
      name: "objects in arrays at the object's depth",
      value: {
        messages: [{ ID: "RSC-005", locations: [{ url: { opaque: false } }] }, { ID: "OPF-001" }],
      },
      expected: [
        "{",
        '  "messages" : [ {',
        '    "ID" : "RSC-005",',
        '    "locations" : [ {',
        '      "url" : {',
        '        "opaque" : false',
        "      }",
        "    } ]",
        "  }, {",
        '    "ID" : "OPF-001"',
        "  } ]",
        "}",
      ].join("\n"),
    },
    {
      name: "escapes quotes, backslashes and control characters only",
      value: { message: 'a "b" \\ c\n\u0001 é/' },
      expected: '{\n  "message" : "a \\"b\\" \\\\ c\\n\\u0001 é/"\n}',
    },
  ])("prints $name", ({ value, expected }) => {
    expect(Jackson.stringify(value)).toBe(expected);
  });
});
