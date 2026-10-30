import type { PackageDocument, SpineItem } from "../opf/PackageDocument.ts";
import type { Finding } from "../references/Collect.ts";
import * as Viewport from "../util/Viewport.ts";
import * as Xml from "../xml/Xml.ts";

// Fixed-layout rules for content documents: which documents are fixed-layout, the viewport
// `meta` element of XHTML documents, and the `viewBox` of SVG documents.

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

// Upstream's OPFHandler30.processItemrefProperties: the legacy `roll` layout is fixed whatever the
// itemref says, and `pre-paginated` is unless the itemref is reflowable.
export const isFixed = (itemref: SpineItem, layouts: ReadonlyArray<string>) =>
  layouts.includes("roll") ||
  (layouts.includes("pre-paginated") &&
    !itemref.properties.includes("rendition:layout-reflowable")) ||
  itemref.properties.includes("rendition:layout-pre-paginated");

// IDs of fixed-layout items: spine items with a fixed itemref, and the direct fallback of each.
// Upstream's FallbackChainResolver passes the property down one level only, and not into a chain
// that never resolves because it loops.
export const fixedLayoutIds = (opf: PackageDocument) => {
  const byId = new Map(opf.items.map((item) => [item.id, item] as const));
  const resolves = (id: string) => {
    const seen = new Set<string>();
    for (let item = byId.get(id); item !== undefined; item = byId.get(item.fallback ?? "")) {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      if (item.fallback === undefined) return true;
    }
    return true;
  };
  const ids = new Set<string>();
  for (const itemref of opf.spineItems) {
    const item = byId.get(itemref.idref);
    if (item === undefined || itemref.padded || !isFixed(itemref, opf.metadata.layouts)) continue;
    ids.add(item.id);
    if (item.fallback !== undefined && byId.has(item.fallback) && resolves(item.fallback)) {
      ids.add(item.fallback);
    }
  }
  return ids;
};

export const fixedLayoutPaths = (opf: PackageDocument) => {
  const ids = fixedLayoutIds(opf);
  return new Set(
    opf.items.flatMap((item) => (item.path !== undefined && ids.has(item.id) ? [item.path] : [])),
  );
};

const at = (
  path: string,
  element: Xml.XmlElement,
  id: Finding["id"],
  ...args: ReadonlyArray<string>
): Finding => ({
  id,
  args,
  path,
  line: element.line,
  column: element.column,
});

const isViewport = (element: Xml.XmlElement) =>
  element.ns === XHTML_NS &&
  element.local === "meta" &&
  (Xml.attribute(element, "name") ?? "").trim() === "viewport";

// Upstream's processMeta, for every viewport `meta` in document order: the first one of a
// fixed-layout document is checked, the others are ignored. HTM-046 is decided at the end of
// `head`, so a viewport after it still counts as the first.
export const xhtmlFindings = (document: Xml.XmlDocument, path: string, fixed: boolean) => {
  const findings: Array<Finding> = [];
  const head = Xml.childElements(document.root).find(
    (element) => element.ns === XHTML_NS && element.local === "head",
  );
  const inHead = (element: Xml.XmlElement) =>
    head !== undefined &&
    (element.line < head.endLine ||
      (element.line === head.endLine && element.column < head.endColumn));
  let checked = false;
  const check = (meta: Xml.XmlElement) => {
    const content = Xml.attribute(meta, "content");
    // Upstream quotes a missing `content` as "null".
    const shown = content ?? "null";
    if (!fixed || checked) {
      findings.push(at(path, meta, fixed ? "HTM-060a" : "HTM-060b", shown));
      return;
    }
    checked = true;
    const viewport = Viewport.parse(content ?? "");
    if (viewport.errors.length > 0) {
      findings.push(at(path, meta, "HTM-047", shown));
      return;
    }
    for (const dimension of ["width", "height"]) {
      const values = viewport.properties
        .filter(([name]) => name === dimension)
        .map(([, value]) => value);
      const [value] = values;
      if (value === undefined) {
        findings.push(at(path, meta, "HTM-056", dimension));
        continue;
      }
      if (values.length > 1) {
        findings.push(
          at(path, meta, "HTM-059", dimension, values.map((each) => `"${each}"`).join(", ")),
        );
      }
      if (!Viewport.isValidProperty(dimension, value)) {
        findings.push(at(path, meta, "HTM-057", dimension));
      }
    }
  };
  const viewports = [...Xml.descendants(document.root)].filter(isViewport);
  for (const meta of viewports.filter(inHead)) check(meta);
  if (fixed && !checked && head !== undefined) {
    findings.push({ id: "HTM-046", args: [], path, line: head.endLine, column: head.endColumn });
  }
  for (const meta of viewports.filter((meta) => !inHead(meta))) check(meta);
  return findings;
};

export const svgFindings = (document: Xml.XmlDocument, path: string, fixed: boolean) =>
  fixed && document.root.ns === SVG_NS && Xml.attribute(document.root, "viewBox") === undefined
    ? [at(path, document.root, "HTM-048")]
    : [];
