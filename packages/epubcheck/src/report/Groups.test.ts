import { describe, expect, it } from "@effect/vitest";

import * as Groups from "./Groups.ts";
import * as Report from "./Report.ts";

const message = (line: number) => ({
  id: "RSC-033" as const,
  severity: "ERROR" as const,
  message: "m",
  suggestion: "",
  location: Report.location("EPUB/nav.xhtml", line, 1),
});

describe("Groups.group", () => {
  // Upstream's CheckMessage drops a location equal to a listed one, and counts the others it
  // has no room for, duplicates included.
  it.each([
    { name: "a repeated location", lines: [2, 2], max: 25, listed: [2], additional: 0 },
    { name: "distinct locations", lines: [2, 3, 2], max: 25, listed: [2, 3], additional: 0 },
    { name: "locations past the limit", lines: [2, 3, 3, 2], max: 1, listed: [2], additional: 2 },
    { name: "no limit", lines: [4, 2, 4], max: -1, listed: [4, 2], additional: 0 },
  ])("merges $name", ({ lines, max, listed, additional }) => {
    const [found] = Groups.group(lines.map(message), max);
    expect(found?.locations.map((location) => location.line)).toEqual(listed);
    expect(found?.additionalLocations).toBe(additional);
  });
});
