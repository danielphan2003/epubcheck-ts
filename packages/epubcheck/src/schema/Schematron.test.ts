import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

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
