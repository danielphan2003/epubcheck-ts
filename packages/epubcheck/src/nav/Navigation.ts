import { keyedSuggestion } from "../messages/MessageCatalog.ts";
import type { Finding } from "../references/Collect.ts";
import * as Url from "../references/Url.ts";
import { percentDecode } from "../util/UrlFragment.ts";
import * as Xml from "../xml/Xml.ts";

// EPUB Navigation Document rules beyond the schemas, as upstream's NavHandler and its reading
// order check apply them: the `toc`, `page-list` and `landmarks` navs link to no remote resource
// (NAV-010), and the `toc` links to spine items in spine order, then document order (NAV-011).

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const OPS_NS = "http://www.idpf.org/2007/ops";

// Upstream tests a nav's types in this order, so the last one it has wins.
const NAV_TYPES = ["toc", "page-list", "landmarks"] as const;

export interface PublicationContext {
  // Content document paths in spine order.
  readonly spine: ReadonlyArray<string>;
  // The position of each ID in each content document, in document order.
  readonly ids: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

export const check = (document: Xml.XmlDocument, path: string, context: PublicationContext) => {
  const findings: Array<Finding> = [];
  const urls = Url.checker(path, { container: true });
  // Every `toc` link of the document is one sequence. A link without a fragment points at its
  // document's start, before every ID; one to an unknown ID is not placed.
  let lastSpine = -1;
  let lastAnchor = -1;
  const navs = Xml.descendants(document.root).filter(
    (element) => element.ns === XHTML_NS && element.local === "nav",
  );
  for (const nav of navs) {
    const types = (Xml.attribute(nav, "type", OPS_NS) ?? "").split(/\s+/);
    const type = NAV_TYPES.findLast((candidate) => types.includes(candidate));
    if (type === undefined) continue;
    for (const link of Xml.descendants(nav)) {
      if (link.ns !== XHTML_NS || link.local !== "a") continue;
      const href = Xml.attribute(link, "href");
      const resolved = href === undefined ? undefined : urls.check(href).resolved;
      if (href === undefined || resolved === undefined) continue;
      const at = { path, line: link.line, column: link.column };
      if (resolved.target.kind === "remote") {
        findings.push({ id: "NAV-010", args: [type, href], ...at });
        continue;
      }
      if (type !== "toc" || resolved.target.kind !== "local") continue;
      const target = resolved.target.path.normalize("NFC");
      const spine = context.spine.indexOf(target);
      if (spine < 0) continue;
      const order = (kind: string) => {
        const args = [type, Url.referenceName(resolved), keyedSuggestion("NAV-011", kind)];
        findings.push({ id: "NAV-011", args, ...at });
      };
      if (spine < lastSpine) {
        order("spine");
        lastSpine = spine;
        lastAnchor = -1;
        continue;
      }
      if (spine > lastSpine) {
        lastSpine = spine;
        lastAnchor = -1;
      }
      const id = percentDecode(resolved.fragment ?? "");
      const found = context.ids.get(target)?.get(id);
      const anchor = id.trim() === "" ? 0 : found === undefined ? -1 : found + 1;
      if (anchor < 0) continue;
      if (anchor < lastAnchor) order("document");
      lastAnchor = anchor;
    }
  }
  return findings;
};
