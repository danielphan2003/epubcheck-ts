import { describe, expect, it } from "@effect/vitest";

import * as Profiles from "./Profiles.ts";

const DICT = "30/dict/dict-xhtml.sch";
const EDUPUB = [
  "30/edupub/edu-structure.sch",
  "30/edupub/edu-semantics.sch",
  "30/idx/idx-xhtml.sch",
];
const INDEX = ["30/idx/idx-xhtml.sch", "30/idx/idx-xhtml-index.sch"];
const placed = { properties: [], inIndex: false, structured: true };

// Each answer is EPUBCheck 5.4.0's: EPUBProfile.makeTypeCompatible and the checkers' validator maps.
describe("Profiles", () => {
  it.each([
    { requested: "default", types: [], profile: "default" },
    { requested: "edupub", types: ["dictionary"], profile: "dict" },
    { requested: "default", types: ["Dictionary"], profile: "dict" },
    { requested: "default", types: ["preview", "index", "edupub"], profile: "edupub" },
    { requested: "idx", types: ["epub", "unknown"], profile: "idx" },
  ] as const)(
    "checks $types requested as $requested as $profile",
    ({ requested, types, profile }) => {
      expect(Profiles.effective(requested, Profiles.knownTypes(types))).toBe(profile);
    },
  );

  it.each([
    { profile: "default", types: [], item: placed, schemas: [] },
    { profile: "dict", types: [], item: placed, schemas: [DICT] },
    {
      profile: "default",
      types: ["DICTIONARY", "EDUPUB"],
      item: placed,
      schemas: [DICT, ...EDUPUB],
    },
    { profile: "edupub", types: [], item: { ...placed, structured: false }, schemas: [] },
    { profile: "edupub", types: [], item: undefined, schemas: EDUPUB },
    {
      profile: "edupub",
      types: [],
      item: { ...placed, inIndex: true },
      schemas: [...EDUPUB, INDEX[1]],
    },
    { profile: "default", types: [], item: { ...placed, properties: ["index"] }, schemas: INDEX },
    {
      profile: "default",
      types: [],
      item: { ...placed, properties: ["data-nav"] },
      schemas: ["30/datanav/datanav-xhtml.sch"],
    },
  ] as const)(
    "selects content document schemas for $profile $types",
    ({ profile, types, item, schemas }) => {
      expect(Profiles.xhtmlSchemas({ profile, types: new Set(types) }, item)).toEqual(schemas);
    },
  );

  it.each([
    { profile: "idx", item: placed, schemas: [] },
    // The index schema keeps the place the EDUPUB rules first list it in.
    { profile: "dict", item: { ...placed, inIndex: true }, schemas: [INDEX[0], DICT, INDEX[1]] },
    { profile: "edupub", item: { ...placed, inIndex: true }, schemas: [...EDUPUB, INDEX[1]] },
  ] as const)("selects navigation document schemas for $profile", ({ profile, item, schemas }) => {
    expect(Profiles.navSchemas({ profile, types: new Set() }, item)).toEqual(schemas);
  });
});
