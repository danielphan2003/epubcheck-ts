import * as Fallbacks from "./Fallbacks.ts";
import { type Context, type Finding, ITEM_MEDIA_TYPE, at, checkedItems } from "./PackageChecks.ts";
import { OEB_PACKAGE_NS, registered } from "./PackageDocument.ts";

// EPUB 2 package document rules: the DOCTYPE (HTM-009), and the media types upstream's
// checkItem and checkSpineItem accept (OPF-035 to OPF-039, OPF-042 to OPF-044).

const OEB_PACKAGE_PUBLIC_ID = "+//ISBN 0-9673008-1-9//DTD OEB 1.2 Package//EN";
const OEB_PACKAGE_SYSTEM_ID = "http://openebook.org/dtds/oeb-1.2/oebpkg12.dtd";

export const check = ({ document, opf }: Context) => {
  const findings: Array<Finding> = [];
  // Upstream checks a DOCTYPE with an external ID, and accepts the OEB 1.2 package one.
  const doctype = document.doctype;
  if (
    doctype !== undefined &&
    (doctype.publicId !== undefined || doctype.systemId !== undefined) &&
    !(
      doctype.name === "package" &&
      (doctype.publicId ?? OEB_PACKAGE_PUBLIC_ID) === OEB_PACKAGE_PUBLIC_ID &&
      (doctype.systemId ?? OEB_PACKAGE_SYSTEM_ID) === OEB_PACKAGE_SYSTEM_ID
    )
  ) {
    findings.push({ id: "HTM-009", args: [], line: doctype.line, column: doctype.column });
  }

  // An OEBPS 1.2 package uses its own namespace, or none. Upstream checks deprecated types only
  // when the whole media type is well formed, parameters excluded.
  const legacy = document.root.ns === OEB_PACKAGE_NS || document.root.ns === "";
  for (const item of checkedItems(opf)) {
    const type = item.mediaType;
    if (
      ITEM_MEDIA_TYPE.test(type) &&
      (Fallbacks.isDeprecatedBlessedItemType(type) || type === "text/x-oeb1-css")
    ) {
      if (type === "text/html") {
        findings.push(legacy ? at(item.element, "OPF-038", type) : at(item.element, "OPF-035"));
      } else if (!legacy) findings.push(at(item.element, "OPF-037", type));
    }
    if (legacy && item.fallback === undefined) {
      if (Fallbacks.isBlessedItemType(type, "2")) findings.push(at(item.element, "OPF-038", type));
      else if (type === "text/css") findings.push(at(item.element, "OPF-039", type));
    }
  }

  // Each itemref is checked, duplicates included: style sheets and images may not be in the
  // spine, and other types need a fallback chain to a content document.
  const byId = new Map([...registered(opf)].map((item) => [item.id, item] as const));
  const contentFallback = Fallbacks.resolveFallbacks(byId, "2").content;
  for (const idref of opf.spine) {
    const item = byId.get(idref);
    if (item === undefined) continue;
    const type = item.mediaType;
    if (Fallbacks.isStyleType(type) || Fallbacks.isBlessedImageType(type, "2")) {
      findings.push(at(item.element, "OPF-042", type));
    } else if (
      !Fallbacks.isBlessedItemType(type, "2") &&
      !Fallbacks.isDeprecatedBlessedItemType(type)
    ) {
      if (item.fallback === undefined) findings.push(at(item.element, "OPF-043", type));
      else if (!contentFallback(item)) findings.push(at(item.element, "OPF-044", type));
    }
  }
  return findings;
};
