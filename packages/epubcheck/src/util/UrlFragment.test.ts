import { describe, expect, it } from "@effect/vitest";

import * as UrlFragment from "./UrlFragment.ts";

describe("UrlFragment.parse", () => {
  // Upstream's scenarios do not cover decoding or media type case; these follow the reference.
  it.each([
    { fragment: "caf%E9", mediaType: "image/svg+xml", id: "caf\uFFFD", isValid: true },
    { fragment: "a%20b%", mediaType: "text/html", id: "a b%", isValid: true },
    { fragment: "%F0%9F%98%80x", mediaType: "text/html", id: "\u{1F600}x", isValid: true },
    { fragment: "t=10", mediaType: "Image/SVG+XML", id: "", isValid: true },
    { fragment: "id:~:text=a,b", mediaType: "text/HTML", id: "id", isValid: true },
  ])("parses $fragment for $mediaType", ({ fragment, mediaType, id, isValid }) => {
    const parsed = UrlFragment.parse(fragment, mediaType);
    expect({ id: parsed.id, isValid: parsed.isValid }).toEqual({ id, isValid });
  });
});
