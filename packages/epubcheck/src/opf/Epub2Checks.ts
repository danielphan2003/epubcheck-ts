import * as Xml from "../xml/Xml.ts";
import { MARC_RELATORS } from "./MarcRelators.ts";
import { type Context, type Finding, at, nowhere, opfChildren } from "./PackageChecks.ts";
import { type ManifestItem, OEB_PACKAGE_NS } from "./PackageDocument.ts";

// EPUB 2 package document rules: the DOCTYPE, Dublin Core roles, OPS media types, and the
// spine's `toc` and Adobe `page-map` attributes.

const DC_NS = "http://purl.org/dc/elements/1.1/";
const OPF_NS = "http://www.idpf.org/2007/opf";
const OEB_PACKAGE_DOCTYPE = "+//ISBN 0-9673008-1-9//DTD OEB 1.2 Package//EN";

// Media types of OPS Content Documents, which spine items must be.
const OPS_TYPES = new Set([
  "application/xhtml+xml",
  "application/x-dtbook+xml",
  "text/x-oeb1-document",
  "text/html",
]);

const DEPRECATED_TYPES = new Set(["text/x-oeb1-css", "text/x-oeb1-document"]);

export const check = ({ document, opf }: Context) => {
  const findings: Array<Finding> = [];
  const root = document.root;
  const legacy = root.ns === OEB_PACKAGE_NS;
  const doctype = document.doctype;
  if (doctype !== undefined && doctype.publicId !== OEB_PACKAGE_DOCTYPE) {
    findings.push({ id: "HTM-009", args: [], line: doctype.line, column: doctype.column });
  }
  if (legacy) findings.push(at(root, "OPF-047"));

  const metadata = opfChildren(root, "metadata")[0];
  const dublinCore =
    metadata === undefined
      ? []
      : [...Xml.descendants(metadata)].filter((element) => element.ns === DC_NS);
  for (const element of dublinCore) {
    const role = Xml.attribute(element, "role", OPF_NS);
    if ((element.local === "creator" || element.local === "contributor") && role !== undefined) {
      if (!MARC_RELATORS.has(role.trim())) findings.push(at(element, "OPF-052", role));
    }
  }

  const byId = new Map(opf.items.map((item) => [item.id, item] as const));
  const essence = (item: ManifestItem) => item.mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  for (const item of opf.items) {
    const type = essence(item);
    if (legacy) {
      if (type === "text/html") findings.push(at(item.element, "OPF-038", item.mediaType));
      if (type === "text/css") findings.push(at(item.element, "OPF-039", item.mediaType));
    } else {
      if (DEPRECATED_TYPES.has(type)) findings.push(at(item.element, "OPF-037", item.mediaType));
      if (type === "text/html") findings.push(at(item.element, "OPF-035"));
    }
  }
  for (const idref of new Set(opf.spine)) {
    const item = byId.get(idref);
    if (item !== undefined && !OPS_TYPES.has(essence(item)) && item.fallback === undefined) {
      findings.push(at(item.element, "OPF-042", item.mediaType));
    }
  }

  const spine = opfChildren(root, "spine")[0];
  if (spine !== undefined) {
    const toc = byId.get(Xml.attribute(spine, "toc")?.trim() ?? "");
    if (toc !== undefined && essence(toc) !== "application/x-dtbncx+xml") {
      findings.push(at(spine, "OPF-050"));
      // Upstream then fails to read the item as an NCX, and says so.
      if (toc.path !== undefined) findings.push(nowhere("CHK-008", toc.path));
    }
    const pageMap = Xml.attribute(spine, "page-map");
    if (pageMap !== undefined) {
      findings.push(at(spine, "OPF-062"));
      if (!byId.has(pageMap.trim())) findings.push(at(spine, "OPF-063", pageMap.trim()));
    }
  }
  return findings;
};
