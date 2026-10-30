import * as Effect from "effect/Effect";

import * as Nvdl from "../schema/Nvdl.ts";
import type * as Xml from "../xml/Xml.ts";
import { preprocess } from "./Preprocess.ts";
import * as XmlChecker from "../xml/XmlChecker.ts";

export type ContentKind = "xhtml" | "nav" | "svg" | "mo" | "ncx" | "skm";

// EPUB 2 has no navigation documents or media overlays, so upstream checks neither there.
export const kindOf = (
  mediaType: string,
  properties: ReadonlyArray<string>,
  version: "2" | "3",
): ContentKind | undefined => {
  switch (mediaType) {
    case "application/xhtml+xml":
      return version === "3" && properties.includes("nav") ? "nav" : "xhtml";
    case "image/svg+xml":
      return "svg";
    case "application/smil+xml":
      return version === "3" ? "mo" : undefined;
    case "application/x-dtbncx+xml":
      return "ncx";
    case "application/vnd.epub.search-key-map+xml":
      return "skm";
    default:
      return undefined;
  }
};

// The schemas and NVDL rewrites upstream's OPSChecker, NavChecker, OverlayChecker and
// NCXChecker apply to each kind of content document.
const validation = (kind: ContentKind, version: "2" | "3") => {
  switch (kind) {
    case "xhtml":
      return version === "2"
        ? {
            schemas: ["20/rng/content-xhtml.rng", "20/sch/xhtml.sch", "20/sch/id-unique.sch"],
            prepare: Nvdl.xhtml20,
          }
        : {
            schemas: ["30/epub-xhtml-30.rnc", "30/epub-xhtml-30.sch"],
            prepare: withPreprocessing("xhtml", Nvdl.xhtml30),
          };
    case "nav":
      return {
        schemas: ["30/epub-nav-30.rnc", "30/epub-xhtml-30.sch", "30/epub-nav-30.sch"],
        prepare: withPreprocessing("xhtml", Nvdl.xhtml30),
      };
    case "svg":
      return version === "2"
        ? {
            schemas: ["20/rng/svg11.rng", "20/sch/id-unique.sch"],
            prepare: (document: Parameters<typeof Nvdl.svg>[0]) => Nvdl.svg(document, "2"),
          }
        : {
            schemas: ["30/epub-svg-30.rnc", "30/epub-svg-30.sch"],
            prepare: withPreprocessing("svg", (document) => Nvdl.svg(document, "3")),
          };
    case "mo":
      return {
        schemas: ["30/media-overlay-30.rnc", "30/media-overlay-30.sch"],
        prepare: undefined,
      };
    case "ncx":
      return { schemas: ["20/rng/ncx.rng", "20/sch/ncx.sch"], prepare: undefined };
    case "skm":
      return { schemas: ["30/dict/search-key-map.rnc"], prepare: undefined };
  }
};

// EPUB 3 XHTML and SVG go through upstream's preprocessing before the NVDL rewrites.
const withPreprocessing =
  (kind: "xhtml" | "svg", next: (document: Xml.XmlDocument) => Nvdl.Prepared) =>
  (document: Xml.XmlDocument): Nvdl.Prepared => {
    const preprocessed = preprocess(document, kind);
    const prepared = next(preprocessed.document);
    return { ...prepared, findings: [...preprocessed.findings, ...(prepared.findings ?? [])] };
  };

// The media type each kind is parsed as, for the DOCTYPE checks.
const MEDIA_TYPES: Readonly<Record<ContentKind, string>> = {
  xhtml: "application/xhtml+xml",
  nav: "application/xhtml+xml",
  svg: "image/svg+xml",
  mo: "application/smil+xml",
  ncx: "application/x-dtbncx+xml",
  skm: "application/vnd.epub.search-key-map+xml",
};

export const check = Effect.fn("ContentChecker.check")(function* (
  bytes: Uint8Array,
  path: string,
  kind: ContentKind,
  version: "2" | "3",
  // Profile and extension schemas, from Profiles.
  extraSchemas: ReadonlyArray<string> = [],
) {
  const { schemas, prepare } = validation(kind, version);
  return yield* XmlChecker.check(bytes, path, [...schemas, ...extraSchemas], {
    prepare,
    isXhtml: kind === "xhtml" || kind === "nav",
    informative: version === "3" && (kind === "xhtml" || kind === "nav" || kind === "svg"),
    version,
    mediaType: MEDIA_TYPES[kind],
  });
});
