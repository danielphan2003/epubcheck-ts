import type { MessageId } from "../messages/MessageCatalog.ts";
import type * as Xml from "../xml/Xml.ts";
import type { SchemaError } from "./Validator.ts";

// The effects of upstream's NVDL scripts (schema/*/…nvdl), applied as tree rewrites before
// RELAX NG validation: "allow" drops foreign sections, "reject" reports them, "unwrap" lifts
// a section's children into its parent.

export const XHTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";
export const OPS_NS = "http://www.idpf.org/2007/ops";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

export interface Prepared {
  readonly document: Xml.XmlDocument;
  readonly errors: ReadonlyArray<SchemaError>;
  // Findings with their own message IDs, such as HTM-061 for an invalid `data-*` name.
  readonly findings?: ReadonlyArray<Finding>;
  // The root itself was rejected, so there is nothing left for the schemas.
  readonly rejectedRoot?: boolean;
}

export interface Finding {
  readonly id: MessageId;
  readonly line: number;
  readonly column: number;
  readonly args: ReadonlyArray<string>;
}

const rejected = (element: Xml.XmlElement): SchemaError => ({
  message: `elements from namespace "${element.ns}" are not allowed`,
  line: element.line,
  column: element.column,
});

const withChildren = (
  element: Xml.XmlElement,
  children: Array<Xml.XmlNode>,
  attributes = element.attributes,
) => ({
  ...element,
  attributes,
  children,
});

// allowOnlyHTML: inside an SVG `title`, only XHTML elements may appear, at any depth.
const titleChildren = (element: Xml.XmlElement, errors: Array<SchemaError>): Array<Xml.XmlNode> =>
  element.children.flatMap((child): Array<Xml.XmlNode> => {
    if (child.kind === "text") return [child];
    if (child.ns !== XHTML_NS) {
      errors.push(rejected(child));
      return [];
    }
    return [withChildren(child, titleChildren(child, errors))];
  });

const FOREIGN_ATTRIBUTE_NS = new Set(["", OPS_NS, XLINK_NS, XML_NS, XMLNS_NS]);

// allowForeignNS: keep SVG and XHTML elements and well-known attributes; drop the rest.
const allowForeign = (
  element: Xml.XmlElement,
  errors: Array<SchemaError>,
  svg30: boolean,
): Xml.XmlElement => {
  if (svg30 && element.ns === SVG_NS && element.local === "foreignObject") return element;
  const attributes =
    element.ns === SVG_NS
      ? element.attributes.filter((attribute) => FOREIGN_ATTRIBUTE_NS.has(attribute.ns))
      : element.attributes;
  const children =
    svg30 && element.ns === SVG_NS && element.local === "title"
      ? titleChildren(element, errors)
      : element.children.flatMap((child): ReadonlyArray<Xml.XmlNode> => {
          if (child.kind === "text") return [child];
          if (child.ns !== SVG_NS && child.ns !== XHTML_NS) return [];
          return [allowForeign(child, errors, svg30)];
        });
  return withChildren(element, children, attributes);
};

export const svg = (document: Xml.XmlDocument, version: "2" | "3"): Prepared => {
  const errors: Array<SchemaError> = [];
  return {
    document: { ...document, root: allowForeign(document.root, errors, version === "3") },
    errors,
  };
};

// epub-svg-30-informative.nvdl: every outermost SVG subtree is checked against the strict SVG
// grammar on its own, keeping only SVG elements and attributes without a namespace.
export const svgSections = (document: Xml.XmlDocument) => {
  const strip = (element: Xml.XmlElement): Xml.XmlElement =>
    withChildren(
      element,
      element.children.flatMap((child): ReadonlyArray<Xml.XmlNode> => {
        if (child.kind === "text") return [child];
        return child.ns === SVG_NS ? [strip(child)] : [];
      }),
      // Namespace declarations are kept: Jing names expected elements with the instance's prefixes.
      element.attributes.filter((attribute) => attribute.ns === "" || attribute.ns === XMLNS_NS),
    );
  const sections: Array<Xml.XmlDocument> = [];
  const visit = (element: Xml.XmlElement) => {
    if (element.ns === SVG_NS) {
      sections.push({ ...document, doctype: undefined, root: strip(element) });
      return;
    }
    for (const child of element.children) if (child.kind === "element") visit(child);
  };
  visit(document.root);
  return sections;
};

export const xhtml30 = (document: Xml.XmlDocument): Prepared => {
  const errors: Array<SchemaError> = [];
  const visit = (element: Xml.XmlElement): Xml.XmlElement => {
    const kept =
      element.ns === SVG_NS && element.local === "title"
        ? titleChildren(element, errors)
        : element.children;
    return withChildren(
      element,
      kept.map((child) => (child.kind === "text" ? child : visit(child))),
    );
  };
  return { document: { ...document, root: visit(document.root) }, errors };
};

// EPUB 2 XHTML: `ops:switch` is replaced by its `ops:default` content; other namespaces than
// XHTML, SVG and OPS are rejected.
export const xhtml20 = (document: Xml.XmlDocument): Prepared => {
  const errors: Array<SchemaError> = [];
  const visit = (element: Xml.XmlElement): Array<Xml.XmlNode> => {
    if (element.ns === OPS_NS) {
      if (element.local !== "switch") return [];
      const fallback = element.children.find(
        (child): child is Xml.XmlElement =>
          child.kind === "element" && child.ns === OPS_NS && child.local === "default",
      );
      return fallback === undefined
        ? []
        : fallback.children.flatMap((child) => (child.kind === "text" ? [child] : visit(child)));
    }
    if (element.ns === SVG_NS) return [allowForeign(element, errors, false)];
    if (element.ns !== XHTML_NS) {
      errors.push(rejected(element));
      return [];
    }
    return [
      withChildren(
        element,
        element.children.flatMap((child) => (child.kind === "text" ? [child] : visit(child))),
      ),
    ];
  };
  const [root] = visit(document.root);
  return root !== undefined && root.kind === "element"
    ? { document: { ...document, root }, errors }
    : { document, errors, rejectedRoot: true };
};
