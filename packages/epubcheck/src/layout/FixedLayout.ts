import type { ManifestItem, PackageDocument } from "../opf/PackageDocument.ts";
import type { Finding } from "../references/Collect.ts";
import * as Viewport from "../util/Viewport.ts";
import * as Xml from "../xml/Xml.ts";

// Fixed-layout rules for content documents: which documents are fixed-layout, the viewport
// `meta` element of XHTML documents, and the `viewBox` of SVG documents.

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

const FIXED = new Set(["pre-paginated", "roll"]);

const layoutOf = (properties: ReadonlyArray<string>, global: string | undefined) => {
  for (const property of properties) {
    const match = /^rendition:layout-(.+)$/.exec(property);
    if (match?.[1] !== undefined) return match[1];
  }
  return global ?? "reflowable";
};

// Container paths of fixed-layout documents: spine items laid out as pre-paginated or roll,
// and every item in their fallback chains.
export const fixedLayoutPaths = (opf: PackageDocument) => {
  const byId = new Map(opf.items.map((item) => [item.id, item] as const));
  const paths = new Set<string>();
  for (const itemref of opf.spineItems) {
    if (!FIXED.has(layoutOf(itemref.properties, opf.metadata.layout))) continue;
    const seen = new Set<string>();
    let item: ManifestItem | undefined = byId.get(itemref.idref);
    while (item !== undefined && !seen.has(item.id)) {
      seen.add(item.id);
      if (item.path !== undefined) paths.add(item.path);
      item = item.fallback === undefined ? undefined : byId.get(item.fallback);
    }
  }
  return paths;
};

// `page-spread-*` properties on spine items that are not pre-paginated (OPF-100).
export const isPrePaginated = (itemProperties: ReadonlyArray<string>, global: string | undefined) =>
  layoutOf(itemProperties, global) === "pre-paginated";

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

export const xhtmlFindings = (document: Xml.XmlDocument, path: string, fixed: boolean) => {
  const findings: Array<Finding> = [];
  const head = Xml.childElements(document.root).find(
    (element) => element.ns === XHTML_NS && element.local === "head",
  );
  const viewports = (head === undefined ? [] : Xml.childElements(head)).filter(
    (element) =>
      element.ns === XHTML_NS &&
      element.local === "meta" &&
      (Xml.attribute(element, "name") ?? "").trim() === "viewport",
  );
  if (!fixed) {
    for (const meta of viewports) {
      findings.push(at(path, meta, "HTM-060b", Xml.attribute(meta, "content") ?? ""));
    }
    return findings;
  }
  const [first, ...others] = viewports;
  if (first === undefined) {
    if (head !== undefined) {
      findings.push({ id: "HTM-046", args: [], path, line: head.endLine, column: head.endColumn });
    }
    return findings;
  }
  const content = Xml.attribute(first, "content") ?? "";
  const viewport = Viewport.parse(content);
  if (viewport.errors.length > 0) findings.push(at(path, first, "HTM-047", content));
  else {
    for (const dimension of ["width", "height"]) {
      const values = viewport.properties
        .filter(([name]) => name === dimension)
        .map(([, value]) => value);
      const [value] = values;
      if (value === undefined) findings.push(at(path, first, "HTM-056", dimension));
      else if (values.length > 1) {
        findings.push(
          at(path, first, "HTM-059", dimension, values.map((each) => `"${each}"`).join(", ")),
        );
      } else if (!Viewport.isValidProperty(dimension, value)) {
        findings.push(at(path, first, "HTM-057", dimension));
      }
    }
  }
  for (const meta of others) {
    findings.push(at(path, meta, "HTM-060a", Xml.attribute(meta, "content") ?? ""));
  }
  return findings;
};

export const svgFindings = (document: Xml.XmlDocument, path: string, fixed: boolean) =>
  fixed && document.root.ns === SVG_NS && Xml.attribute(document.root, "viewBox") === undefined
    ? [at(path, document.root, "HTM-048")]
    : [];
