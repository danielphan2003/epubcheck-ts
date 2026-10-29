import type * as Collect from "../references/Collect.ts";
import * as Url from "../references/Url.ts";
import * as Xml from "../xml/Xml.ts";

// NCX rules beyond the schemas: the `dtb:uid` must match the publication's identifier, empty
// labels are noted, and `content` links point to OPS content documents.

const NCX_NS = "http://www.daisy.org/z3986/2005/ncx/";

export const check = (
  document: Xml.XmlDocument,
  path: string,
  uniqueIdentifier: string | undefined,
) => {
  const findings: Array<Collect.Finding> = [];
  const elements = [document.root, ...Xml.descendants(document.root)].filter(
    (element) => element.ns === NCX_NS,
  );
  const uid = elements.find(
    (element) => element.local === "meta" && Xml.attribute(element, "name") === "dtb:uid",
  );
  const value = uid === undefined ? undefined : Xml.attribute(uid, "content");
  if (value !== undefined) {
    if (value !== value.trim()) {
      findings.push({ id: "NCX-004", args: [], path, line: -1, column: -1 });
    }
    if (uniqueIdentifier !== undefined && value.trim() !== uniqueIdentifier.trim()) {
      findings.push({
        id: "NCX-001",
        args: [value, uniqueIdentifier],
        path,
        line: -1,
        column: -1,
      });
    }
  }
  for (const element of elements) {
    if (element.local === "text" && Xml.textContent(element).trim() === "") {
      findings.push({ id: "NCX-006", args: [], path, line: element.line, column: element.column });
    }
  }
  return findings;
};

// Upstream checks `content` links as hyperlinks.
export const references = (document: Xml.XmlDocument, path: string, context: Collect.Context) => {
  const references: Array<Collect.Reference> = [];
  const findings: Array<Collect.Finding> = [];
  const urls = Url.checker(path, context);
  for (const element of Xml.descendants(document.root)) {
    const src = Xml.attribute(element, "src");
    if (element.ns !== NCX_NS || element.local !== "content" || src === undefined) continue;
    const at = { path, line: element.line, column: element.column };
    const { problems, resolved } = urls.check(src);
    for (const problem of problems) findings.push({ ...problem, ...at });
    if (resolved !== undefined) {
      references.push({ ...resolved, type: "hyperlink", resource: false, ...at });
    }
  }
  return { references, findings };
};
