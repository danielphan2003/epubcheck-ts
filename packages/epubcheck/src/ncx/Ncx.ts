import type * as Collect from "../references/Collect.ts";
import * as Url from "../references/Url.ts";
import * as JavaText from "../util/JavaText.ts";
import * as Xml from "../xml/Xml.ts";

// NCX rules beyond the schemas: the `dtb:uid` must match the publication's identifier, empty
// labels are noted, and `content` links point to OPS content documents.

const NCX_NS = "http://www.daisy.org/z3986/2005/ncx/";

const NCX_PUBLIC_ID = "-//NISO//DTD ncx 2005-1//EN";
const NCX_SYSTEM_ID = "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd";

// The text an element holds directly, as upstream's handlers collect it; undefined without any.
const ownText = (element: Xml.XmlElement) => {
  const texts = element.children.flatMap((child) => (child.kind === "text" ? [child.text] : []));
  return texts.length === 0 ? undefined : texts.join("");
};

// `uid` is upstream's publication identifier (PackageDocument's `uid`).
export const check = (
  document: Xml.XmlDocument,
  path: string,
  uid: string | undefined,
  version: "2" | "3",
) => {
  const findings: Array<Collect.Finding> = [];
  // EPUB 2 NCX documents may only use the NCX 2005-1 DOCTYPE, if any (HTM-004).
  const doctype = document.doctype;
  const found =
    version !== "2" || doctype === undefined
      ? undefined
      : doctype.publicId !== NCX_PUBLIC_ID
        ? (doctype.publicId ?? "")
        : doctype.systemId !== NCX_SYSTEM_ID
          ? (doctype.systemId ?? "")
          : undefined;
  if (doctype !== undefined && found !== undefined) {
    const expected = `<!DOCTYPE ncx PUBLIC "${NCX_PUBLIC_ID}" \n "${NCX_SYSTEM_ID}">`;
    findings.push({
      id: "HTM-004",
      args: [found, expected],
      path,
      line: doctype.line,
      column: doctype.column,
    });
  }
  const elements = [document.root, ...Xml.descendants(document.root)].filter(
    (element) => element.ns === NCX_NS,
  );
  // Upstream checks each label at its end tag.
  for (const element of elements) {
    if (element.local !== "text") continue;
    const text = ownText(element);
    if (text === undefined || JavaText.trim(text) === "") {
      findings.push({
        id: "NCX-006",
        args: [],
        path,
        line: element.endLine,
        column: element.endColumn,
      });
    }
  }
  // The last `dtb:uid` wins.
  const ncxId = elements
    .filter((element) => element.local === "meta" && Xml.attribute(element, "name") === "dtb:uid")
    .map((element) => Xml.attribute(element, "content"))
    .at(-1);
  if (ncxId !== undefined && ncxId !== JavaText.trim(ncxId)) {
    findings.push({ id: "NCX-004", args: [], path, line: -1, column: -1 });
  }
  if (uid !== undefined && ncxId !== undefined && uid !== JavaText.trim(ncxId)) {
    findings.push({ id: "NCX-001", args: [ncxId, uid], path, line: -1, column: -1 });
  }
  return findings;
};

// Upstream checks `content` links as hyperlinks.
export const references = (document: Xml.XmlDocument, path: string, context: Collect.Context) => {
  const links: Array<Collect.Reference> = [];
  const findings: Array<Collect.Finding> = [];
  const urls = Url.checker(path, context);
  for (const element of Xml.descendants(document.root)) {
    const src = Xml.attribute(element, "src");
    if (element.ns !== NCX_NS || element.local !== "content" || src === undefined) continue;
    const at = { path, line: element.line, column: element.column };
    const { problems, resolved } = urls.check(src);
    for (const problem of problems) findings.push({ ...problem, ...at });
    if (resolved !== undefined) {
      links.push({ ...resolved, type: "hyperlink", resource: false, ...at });
    }
  }
  return { references: links, findings };
};
