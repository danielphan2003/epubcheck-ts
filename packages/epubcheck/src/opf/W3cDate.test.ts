import { describe, expect, it } from "@effect/vitest";

import * as W3cDate from "./W3cDate.ts";

describe("W3cDate.problem", () => {
  // Each answer is EPUBCheck 5.4.0's, from OPF-053 and OPF-054.
  it.each([
    { value: "2010-05-12T00:00:00", problem: undefined },
    { value: "2020-1-1T1:1:1Z", problem: undefined },
    { value: "999", problem: undefined },
    { value: "2020-01-01T10:00:00.123Z", problem: undefined },
    { value: "1500-02-29", problem: undefined },
    { value: "2019-02-29T10:00+01:00", problem: undefined },
    { value: "", problem: "zero-length string" },
    { value: "   ", problem: "Empty Date" },
    { value: "abcd", problem: '[For input string: "abcd"] is not an integer' },
    { value: "2020-01-01 10:00", problem: '[For input string: "01 10"] is not an integer' },
    { value: "2020-01-01T", problem: "Incomplete date." },
    { value: "2020-01-01Z", problem: "Unexpected: Z" },
    { value: "2020-01-01T10:00:00+0100", problem: "Missing minute field" },
    { value: "2020-01-01T10:00:", problem: "No secondes specified" },
    {
      value: "2020-01-01T10:00:00Zx",
      problem: "Unexpected field at the end of the date field: x",
    },
    {
      value: "2020-01-01T10:00:00.1234x",
      problem: "Invalid digit in the decimal fraction of a second: x",
    },
    { value: "10000", problem: "10000" },
    {
      value: "2019-02-29",
      problem: "2019-02-29 class java.lang.IllegalArgumentException MONTH: 1 -> 2",
    },
    {
      value: "2020-12-32",
      problem: "2020-12-32 class java.lang.IllegalArgumentException DAY_OF_MONTH",
    },
    { value: "0", problem: "0 class java.lang.IllegalArgumentException YEAR" },
    {
      value: "1582-10-10",
      problem:
        "1582-10-10 class java.lang.IllegalArgumentException the specified date doesn't exist",
    },
  ])("checks $value", ({ value, problem }) => {
    expect(W3cDate.problem(value)).toBe(problem);
  });
});
