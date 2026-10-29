import { describe, expect, it } from "@effect/vitest";

import * as Schemas from "./Schemas.ts";

// The RELAX NG schemas the checkers validate against.
const ENTRIES = [
  "20/rng/opf.rng",
  "20/rng/container.rng",
  "20/rng/encryption.rng",
  "20/rng/signatures.rng",
  "20/rng/content-xhtml.rng",
  "20/rng/svg11.rng",
  "20/rng/ncx.rng",
  "30/package-30.rnc",
  "30/ocf-container-30.rnc",
  "30/ocf-encryption-30.rnc",
  "30/ocf-signatures-30.rnc",
  "30/ocf-metadata-30.rnc",
  "30/epub-xhtml-30.rnc",
  "30/epub-nav-30.rnc",
  "30/epub-svg-30.rnc",
  "30/epub-svg-30-informative.rnc",
  "30/media-overlay-30.rnc",
];

describe("Schemas", () => {
  it.each(ENTRIES)("compiles %s", (path) => {
    expect(Schemas.compileErrors(path)).toEqual([]);
  });
});
