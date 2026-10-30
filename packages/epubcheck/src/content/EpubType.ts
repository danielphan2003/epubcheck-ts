import { keyedSuggestion } from "../messages/MessageCatalog.ts";
import * as Vocabularies from "../opf/Vocabularies.ts";
import type { Finding } from "../references/Collect.ts";
import * as Xml from "../xml/Xml.ts";

// `epub:type` in content documents and media overlays: prefixed values need a declared prefix,
// and unprefixed ones come from the Structural Semantics Vocabulary. The term sets are what
// upstream recognizes, which is not exactly the published vocabulary.

const OPS_NS = "http://www.idpf.org/2007/ops";

// Upstream's StructureVocab terms, apart from the deprecated ones and those meant for SVG.
const STRUCTURE = new Set([
  "abstract",
  "acknowledgments",
  "afterword",
  "appendix",
  "assessment",
  "backlink",
  "backmatter",
  "bibliography",
  "biblioref",
  "bodymatter",
  "chapter",
  "colophon",
  "concluding-sentence",
  "conclusion",
  "contributors",
  "copyright-page",
  "cover",
  "covertitle",
  "credit",
  "credits",
  "dedication",
  "division",
  "endnotes",
  "epigraph",
  "epilogue",
  "errata",
  "footnote",
  "footnotes",
  "foreword",
  "frontmatter",
  "fulltitle",
  "glossary",
  "glossdef",
  "glossref",
  "glossterm",
  "halftitle",
  "halftitlepage",
  "imprimatur",
  "imprint",
  "index",
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
  "part",
  "preamble",
  "preface",
  "prologue",
  "pullquote",
  "qna",
  "revision-history",
  "subtitle",
  "tip",
  "title",
  "titlepage",
  "toc",
  "topic-sentence",
  "volume",
]);

// The dictionary, index, comics and data navigation terms that content documents also accept.
const CONTENT_ONLY = new Set([
  "antonym-group",
  "balloon",
  "condensed-entry",
  "def",
  "dictentry",
  "dictionary",
  "etymology",
  "example",
  "gram-info",
  "idiom",
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
  "panel",
  "panel-group",
  "part-of-speech",
  "part-of-speech-group",
  "part-of-speech-list",
  "phonetic-transcription",
  "phrase-group",
  "phrase-list",
  "region-based",
  "sense-group",
  "sense-list",
  "sound-area",
  "synonym-group",
  "text-area",
  "tran",
  "tran-info",
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

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SMIL = "application/smil+xml";

// Prefixes are declared on an XHTML `html` element, which upstream reads before its types, or on a
// media overlay's `smil` element, which it reads after them. A standalone SVG declares none.
export const check = (document: Xml.XmlDocument, path: string, mediaType: string) => {
  const findings: Array<Finding> = [];
  const at = (element: Xml.XmlElement, id: Finding["id"], ...args: ReadonlyArray<string>) =>
    findings.push({ id, args, path, line: element.line, column: element.column });
  const overlay = mediaType === SMIL;
  const scope = overlay ? Vocabularies.OVERLAY_PREFIXES : Vocabularies.CONTENT_PREFIXES;
  const known = (term: string) => STRUCTURE.has(term) || (!overlay && CONTENT_ONLY.has(term));
  const declares = (element: Xml.XmlElement) =>
    overlay ? element.local === "smil" : element.ns === XHTML_NS && element.local === "html";
  let prefixes = Vocabularies.parsePrefixes(undefined, scope);
  const declare = (element: Xml.XmlElement) => {
    prefixes = Vocabularies.parsePrefixes(Xml.attribute(element, "prefix", OPS_NS), scope);
    for (const problem of prefixes.problems) at(element, problem.id, ...problem.args);
  };
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    if (!overlay && declares(element)) declare(element);
    const value = Xml.attribute(element, "type", OPS_NS);
    // Upstream reports an unrecognized term once, after the element's other messages.
    const unknown = new Set<string>();
    // Java's `\s`, which leaves U+00A0 and other Unicode spaces inside a token.
    for (const token of (value ?? "").split(/[ \t\n\v\f\r]+/).filter((term) => term !== "")) {
      const colon = token.indexOf(":");
      if (colon === 0 || colon === token.length - 1) {
        at(element, "OPF-026", token);
      } else if (colon > 0) {
        const prefix = token.slice(0, colon);
        const vocab = prefixes.vocabs.get(prefix);
        // A deprecated vocabulary is deprecated under its reserved prefix only.
        if (vocab === undefined) at(element, "OPF-028", prefix);
        else if (vocab.deprecated && scope.reserved[prefix]?.uri === vocab.uri) {
          at(element, "OPF-086c", prefix);
        }
      } else if (DEPRECATED.has(token)) {
        at(element, "OPF-086b", token, keyedSuggestion("OPF-086b", token));
      } else if (NOT_FOR_XHTML.has(token)) {
        if (mediaType === "application/xhtml+xml") at(element, "OPF-087", token, mediaType);
      } else if (!known(token)) unknown.add(token);
    }
    for (const term of unknown) at(element, "OPF-088", term);
    if (overlay && declares(element)) declare(element);
  }
  return findings;
};
