import { describe, expect, it } from "@effect/vitest";

import { checkLanguageTag } from "./LanguageTag.ts";

describe("checkLanguageTag", () => {
  // Each answer is ICU's, as EPUBCheck 5.4.0 reports it in OPF-092.
  it.each([
    { tag: "en-US", problem: undefined },
    { tag: "i-klingon", problem: undefined },
    { tag: "zh-min-nan", problem: undefined },
    { tag: "abcde-abc", problem: undefined },
    { tag: "en-Latn-US-1abc-a-bc-x-1", problem: undefined },
    { tag: "en-", problem: "Empty subtag [at index 3]" },
    { tag: "-en", problem: "Empty subtag [at index 0]" },
    { tag: "x", problem: "Incomplete privateuse [at index 0]" },
    { tag: "en-US-x-", problem: "Incomplete privateuse [at index 6]" },
    { tag: "en-a-b", problem: "Incomplete extension 'a' [at index 3]" },
    { tag: "en-0-abc", problem: "Invalid subtag: 0 [at index 3]" },
    { tag: "123", problem: "Invalid subtag: 123 [at index 0]" },
  ])("checks $tag", ({ tag, problem }) => {
    expect(checkLanguageTag(tag)).toBe(problem);
  });
});
