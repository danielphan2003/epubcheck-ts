import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import * as EpubType from "./EpubType.ts";

const EPUB = 'xmlns:epub="http://www.idpf.org/2007/ops"';
const MSV = "http://www.idpf.org/epub/vocab/structure/magazine/#";
const attributes = (parts: { readonly prefix?: string; readonly type?: string }) =>
  (parts.prefix === undefined ? "" : ` epub:prefix="${parts.prefix}"`) +
  (parts.type === undefined ? "" : ` epub:type="${parts.type}"`);
const xhtml = (root: { prefix?: string; type?: string }, type: string) =>
  `<html xmlns="http://www.w3.org/1999/xhtml" ${EPUB}${attributes(root)}><head><title>t</title></head><body><p epub:type="${type}">x</p></body></html>`;
const smil = (root: { prefix?: string; type?: string }, type: string) =>
  `<smil xmlns="http://www.w3.org/ns/SMIL" ${EPUB} version="3.0"${attributes(root)}><body epub:type="${type}"><par><text src="c.xhtml#a"/></par></body></smil>`;
const svg = (root: { prefix?: string }, type: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${EPUB}${attributes(root)}><g epub:type="${type}"/></svg>`;

describe("EpubType.check", () => {
  // Each row was checked against EPUBCheck 5.4.0 on a single document.
  it.each([
    {
      name: "a prefix for the package meta vocabulary",
      source: xhtml({ prefix: "m: http://idpf.org/epub/vocab/package/meta/#" }, "m:a"),
      ids: [],
    },
    {
      name: "a prefix for the structure vocabulary",
      source: xhtml({ prefix: "s: http://www.idpf.org/epub/vocab/structure/#" }, "s:b"),
      ids: ["OPF-007b", "OPF-028"],
    },
    {
      name: "the package's deprecated xsd prefix",
      source: xhtml({ prefix: "xsd: http://www.w3.org/2001/XMLSchema#" }, "xsd:a"),
      ids: [],
    },
    {
      name: "a declared msv prefix",
      source: xhtml({ prefix: `msv: ${MSV}` }, "msv:a"),
      ids: ["OPF-086c", "OPF-086c"],
    },
    { name: "another prefix for msv", source: xhtml({ prefix: `m: ${MSV}` }, "m:a"), ids: [] },
    {
      name: "malformed values",
      source: xhtml({}, ":foo foo: :"),
      ids: ["OPF-026", "OPF-026", "OPF-026"],
    },
    { name: "dictionary terms", source: xhtml({}, "conclusion antonym-group"), ids: [] },
    { name: "a no-break space", source: xhtml({}, "chapter\u00a0toc"), ids: ["OPF-088"] },
    {
      name: "repeated unrecognized terms",
      source: xhtml({}, "foo note bar foo"),
      ids: ["OPF-086b", "OPF-088", "OPF-088"],
    },
    {
      name: "the root's types, after its prefixes",
      source: xhtml({ prefix: "z: http://e.org/z#", type: "z:a" }, "chapter"),
      ids: [],
    },
    {
      name: "a reserved prefix in an overlay",
      source: smil({}, "prism:b"),
      ids: ["OPF-028"],
      type: "application/smil+xml",
    },
    {
      name: "dictionary terms in an overlay",
      source: smil({}, "dictionary index-entry"),
      ids: ["OPF-088", "OPF-088"],
      type: "application/smil+xml",
    },
    {
      name: "an overlay root's types, before its prefixes",
      source: smil({ prefix: "z: http://e.org/z#", type: "z:a" }, "chapter"),
      ids: ["OPF-028"],
      type: "application/smil+xml",
    },
    {
      name: "prefixes on a standalone SVG",
      source: svg({ prefix: "z: http://e.org/z#" }, "z:a"),
      ids: ["OPF-028"],
      type: "image/svg+xml",
    },
  ])("reports $name", ({ source, ids, ...row }) => {
    const parsed = Xml.parse(source);
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    const mediaType = "type" in row ? row.type : "application/xhtml+xml";
    const findings = EpubType.check(parsed.success, "a.xhtml", mediaType);
    expect(findings.map((finding) => finding.id)).toEqual(ids);
  });
});
