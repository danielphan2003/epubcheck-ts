import { describe, expect, it } from "@effect/vitest";

import * as Collect from "./Collect.ts";

describe("Collect.srcsetUrls", () => {
  it.each([
    { srcset: "a.png 1x, b.png 2x", urls: ["a.png", "b.png"] },
    // As in HTML, a URL runs to the next space, commas included.
    { srcset: "a.png,b.png", urls: ["a.png,b.png"] },
    { srcset: "a.png 100w, b.png (max-width: 10px) 200w", urls: ["a.png", "b.png"] },
    {
      srcset: "data:image/png;base64,AAA= 1x, b.png 2x",
      urls: ["data:image/png;base64,AAA=", "b.png"],
    },
    { srcset: "data:image/png;base64,\n  AAA= 1x", urls: ["data:image/png;base64,AAA="] },
  ])("reads $srcset", ({ srcset, urls }) => {
    expect(Collect.srcsetUrls(srcset)).toEqual(urls);
  });
});
