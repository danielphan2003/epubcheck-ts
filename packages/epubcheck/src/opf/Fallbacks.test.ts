import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import * as Fallbacks from "./Fallbacks.ts";
import * as PackageDocument from "./PackageDocument.ts";

describe("Fallbacks.resolveFallbacks", () => {
  const item = (id: string, type: string, extra = "") =>
    `<item id="${id}" href="${id}.x" media-type="${type}"${extra}/>`;
  // Each row was checked against EPUBCheck 5.4.0, through RSC-010, RSC-032 and OPF-044.
  it.each([
    {
      name: "an HTML fallback",
      manifest: item("a", "application/pdf", ' fallback="h"') + item("h", "text/html"),
      version: "3",
      content: true,
      core: false,
    },
    {
      name: "a fallback style sheet in EPUB 2",
      manifest: item("a", "application/x-poem+xml", ' fallback-style="s"') + item("s", "text/css"),
      version: "2",
      content: true,
      core: true,
    },
    {
      name: "a loop through a core type",
      manifest:
        item("a", "application/pdf", ' fallback="i"') + item("i", "image/png", ' fallback="a"'),
      version: "3",
      content: false,
      core: false,
    },
  ] as const)("resolves $name", ({ manifest, version, content, core }) => {
    const parsed = Xml.parse(
      `<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0"><metadata/><manifest>${manifest}</manifest><spine/></package>`,
    );
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    const opf = PackageDocument.read(parsed.success, "EPUB/package.opf", version);
    const byId = new Map([...PackageDocument.registered(opf)].map((entry) => [entry.id, entry]));
    const fallbacks = Fallbacks.resolveFallbacks(byId, version);
    const first = byId.get("a");
    expect(first !== undefined && [fallbacks.content(first), fallbacks.core(first)]).toEqual([
      content,
      core,
    ]);
  });
});
