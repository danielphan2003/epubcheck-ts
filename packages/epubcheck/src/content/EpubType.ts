import { keyedSuggestion } from "../messages/MessageCatalog.ts";
import * as Vocabularies from "../opf/Vocabularies.ts";
import type { Finding } from "../references/Collect.ts";
import * as Xml from "../xml/Xml.ts";

// `epub:type` in content documents and media overlays: prefixed values need a declared prefix,
// and unprefixed ones come from the Structural Semantics Vocabulary. The term sets are what
// upstream recognizes, which is not exactly the published vocabulary.

const OPS_NS = "http://www.idpf.org/2007/ops";

const STRUCTURE = new Set([
  "abstract",
  "acknowledgments",
  "afterword",
  "appendix",
  "assessment",
  "backlink",
  "backmatter",
  "balloon",
  "biblioref",
  "bibliography",
  "bodymatter",
  "chapter",
  "colophon",
  "concluding-sentence",
  "condensed-entry",
  "contributors",
  "copyright-page",
  "cover",
  "covertitle",
  "credit",
  "credits",
  "dedication",
  "def",
  "dictentry",
  "dictionary",
  "division",
  "endnotes",
  "epigraph",
  "epilogue",
  "errata",
  "etymology",
  "example",
  "footnote",
  "footnotes",
  "foreword",
  "frontmatter",
  "fulltitle",
  "glossary",
  "glossdef",
  "glossref",
  "glossterm",
  "gram-info",
  "halftitle",
  "halftitlepage",
  "idiom",
  "imprimatur",
  "imprint",
  "index",
  "index-editor-note",
  "index-entry",
  "index-entry-list",
  "index-group",
  "index-headnotes",
  "index-legend",
  "index-locator",
  "index-locator-list",
  "index-locator-range",
  "index-term",
  "index-term-categories",
  "index-term-category",
  "index-xref-preferred",
  "index-xref-related",
  "introduction",
  "keyword",
  "landmarks",
  "learning-objective",
  "learning-resource",
  "loa",
  "loi",
  "lot",
  "lov",
  "noteref",
  "notice",
  "other-credits",
  "page-list",
  "pagebreak",
  "panel",
  "panel-group",
  "part",
  "part-of-speech",
  "phonetic-transcription",
  "preamble",
  "preface",
  "prologue",
  "pullquote",
  "qna",
  "region-based",
  "revision-history",
  "sense-group",
  "sense-list",
  "sound-area",
  "subtitle",
  "text-area",
  "tip",
  "title",
  "titlepage",
  "toc",
  "topic-sentence",
  "tran",
  "tran-info",
  "volume",
]);

// Terms meant for SVG, which XHTML expresses with its own elements.
const NOT_FOR_XHTML = new Set([
  "aside",
  "figure",
  "list",
  "list-item",
  "table",
  "table-cell",
  "table-row",
]);

const DEPRECATED = new Set([
  "annoref",
  "annotation",
  "biblioentry",
  "bridgehead",
  "endnote",
  "help",
  "marginalia",
  "note",
  "rearnote",
  "rearnotes",
  "sidebar",
  "subchapter",
  "warning",
]);

export const check = (document: Xml.XmlDocument, path: string, mediaType: string) => {
  const findings: Array<Finding> = [];
  const at = (element: Xml.XmlElement, id: Finding["id"], ...args: ReadonlyArray<string>) =>
    findings.push({ id, args, path, line: element.line, column: element.column });
  const prefixes = Vocabularies.parsePrefixes(
    Xml.attribute(document.root, "prefix", OPS_NS),
    Vocabularies.CONTENT_RESERVED,
  );
  for (const problem of prefixes.problems) at(document.root, problem.id, ...problem.args);
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    const value = Xml.attribute(element, "type", OPS_NS);
    if (value === undefined) continue;
    for (const token of value.split(/\s+/).filter((term) => term !== "")) {
      const colon = token.indexOf(":");
      if (colon >= 0) {
        const prefix = token.slice(0, colon);
        const vocab = prefixes.vocabs.get(prefix);
        if (vocab === undefined) at(element, "OPF-028", prefix);
        else if (vocab.deprecated) at(element, "OPF-086c", prefix);
      } else if (DEPRECATED.has(token)) {
        at(element, "OPF-086b", token, keyedSuggestion("OPF-086b", token));
      } else if (NOT_FOR_XHTML.has(token)) {
        if (mediaType === "application/xhtml+xml") at(element, "OPF-087", token, mediaType);
      } else if (!STRUCTURE.has(token)) at(element, "OPF-088", token);
    }
  }
  return findings;
};
