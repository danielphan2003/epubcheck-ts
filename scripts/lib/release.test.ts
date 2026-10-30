import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { compareVersions, parseRelease, previousReleaseTag } from "./release.ts";

const release = (raw: string) => Option.getOrThrow(parseRelease(raw));

describe("parseRelease", () => {
  it("accepts a version with or without the leading v", () => {
    expect(release("v1.2.3")).toEqual({
      version: "1.2.3",
      tag: "v1.2.3",
      isPrerelease: false,
      makeLatest: true,
    });
    expect(release("0.1.0").tag).toBe("v0.1.0");
  });

  it("publishes a suffixed version as a prerelease that is never latest", () => {
    expect(release("v1.2.3-alpha.1")).toMatchObject({ isPrerelease: true, makeLatest: false });
  });

  it.each(["", "v", "1.2", "1.2.3.4", "01.2.3", "1.2.3-", "1.2.3+build", "latest", "v1.2.3 x"])(
    "rejects %j",
    (raw) => {
      expect(Option.isNone(parseRelease(raw))).toBe(true);
    },
  );
});

describe("compareVersions", () => {
  it("orders versions by Semantic Versioning precedence", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.10.0",
      "2.0.0",
    ];
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort(compareVersions)).toEqual(ordered);
  });
});

describe("previousReleaseTag", () => {
  const tags = ["v0.1.0", "v0.2.0-rc.1", "v0.2.0", "v0.3.0-rc.1", "v0.3.0-rc.2", "nightly", "v9.9"];

  it("compares a stable release with the previous stable one", () => {
    expect(previousReleaseTag(tags, release("0.3.0"))).toEqual(Option.some("v0.2.0"));
  });

  it("compares a prerelease with the release just before it", () => {
    expect(previousReleaseTag(tags, release("0.3.0-rc.2"))).toEqual(Option.some("v0.3.0-rc.1"));
  });

  it("has none for the first release", () => {
    expect(previousReleaseTag(tags, release("0.1.0"))).toEqual(Option.none());
    expect(previousReleaseTag([], release("1.0.0"))).toEqual(Option.none());
  });

  it("ignores the current tag and tags that are not releases", () => {
    expect(previousReleaseTag(["v1.0.0", "v1.0.0-junk!", "release-0.9"], release("1.0.0"))).toEqual(
      Option.none(),
    );
  });
});
