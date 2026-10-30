import type { MessageId } from "../messages/MessageCatalog.ts";
import type { Finding } from "../references/Collect.ts";
import * as JavaText from "../util/JavaText.ts";
import * as Xml from "../xml/Xml.ts";

// EPUB 3 XHTML and SVG content document rules the schemas do not express: the XML version and
// DOCTYPE, discouraged and deprecated constructs, alternate style sheets, SSML, MathML
// alternatives, and URL schemes.

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const SSML_NS = "http://www.w3.org/2001/10/synthesis";
const OPS_NS = "http://www.idpf.org/2007/ops";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

const DISCOURAGED = new Set(["base", "embed", "rp"]);
// SVG elements whose deprecated `xlink:href` upstream reports.
const XLINKED = new Set(["a", "font-face-uri", "image", "use"]);

// Alternate style tags (EPUB Alternate Style Tags 1.0) that cannot apply together.
const CONFLICTING_TAGS = [
  ["day", "night"],
  ["horizontal", "vertical"],
] as const;

// Upstream's URISchemes, the schemes a remote link may use without HTM-025.
const REGISTERED_SCHEMES = new Set([
  "aaa",
  "aaas",
  "acap",
  "cap",
  "cid",
  "crid",
  "data",
  "dav",
  "dict",
  "dns",
  "fax",
  "file",
  "ftp",
  "go",
  "gopher",
  "h323",
  "http",
  "https",
  "icap",
  "im",
  "imap",
  "info",
  "ipp",
  "irc",
  "iris",
  "iris.beep",
  "iris.xpc",
  "iris.xpcs",
  "iris.lwz",
  "javascript",
  "ldap",
  "mailto",
  "mid",
  "modem",
  "msrp",
  "msrps",
  "mtqp",
  "mupdate",
  "news",
  "nfs",
  "nntp",
  "opaquelocktoken",
  "pop",
  "pres",
  "rtsp",
  "service",
  "shttp",
  "sip",
  "sips",
  "snmp",
  "soap.beep",
  "soap.beeps",
  "tag",
  "tel",
  "telnet",
  "tftp",
  "thismessage",
  "tip",
  "tv",
  "urn",
  "vemmi",
  "xmlrpc.beep",
  "xmlrpc.beeps",
  "xmpp",
  "z39.50r",
  "z39.50s",
  "afs",
  "dtn",
  "iax",
  "mailserver",
  "pack",
  "tn3270",
  "prospero",
  "snews",
  "videotex",
  "wais",
]);

const at = (
  path: string,
  element: { readonly line: number; readonly column: number },
  id: MessageId,
  ...args: ReadonlyArray<string>
) => ({
  id,
  args,
  path,
  line: element.line,
  column: element.column,
});

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

// URL schemes galimatias parses strictly. It fails on their invalid hosts and non-digit ports,
// but not on out-of-range ones.
const SPECIAL_SCHEMES = new Set(["ftp", "file", "gopher", "http", "https", "ws", "wss"]);
const PORT = /^([^:]+:\/\/(?:[^@/?#]*@)?(?:\[[^\]]*\]|[^:/?#]*)):\d*(?=[/?#\\]|$)/;

// Galimatias resolves a URL against a base of a special scheme only; a port it accepts and the
// WHATWG parser rejects does not change the scheme.
const resolve = (value: string, base: URL | undefined) => {
  const special =
    base !== undefined && SPECIAL_SCHEMES.has(base.protocol.slice(0, -1)) ? base : undefined;
  if (special === undefined && !SCHEME.test(value)) return null;
  return URL.parse(value, special) ?? URL.parse(value.replace(PORT, "$1"), special);
};

// Upstream's checkHRef: a link to a URL outside the container, absolute or resolved against a
// remote base, needs a scheme upstream knows (HTM-025); blank links and `.` are checked elsewhere.
const schemeFinding = (
  path: string,
  element: Xml.XmlElement,
  href: string | undefined,
  base: URL | undefined,
) => {
  const value = JavaText.trim(href ?? "");
  if (value === "" || value === ".") return [];
  const url = JavaText.stripWhitespace(value);
  // Galimatias accepts a URL of a scheme that is not special without parsing it further.
  const own = SCHEME.exec(url)?.[1]?.toLowerCase();
  const scheme =
    own !== undefined && !SPECIAL_SCHEMES.has(own)
      ? own
      : resolve(url, base)?.protocol.slice(0, -1);
  if (scheme === undefined || REGISTERED_SCHEMES.has(scheme)) return [];
  return [at(path, element, "HTM-025")];
};

// Upstream's getSVGHrefs: an SVG link element's `href`, and its deprecated `xlink:href`.
const svgHrefs = (path: string, element: Xml.XmlElement) => {
  const xlink = Xml.attribute(element, "href", XLINK_NS);
  const href = Xml.attribute(element, "href");
  if (xlink !== undefined && href === undefined) {
    return { findings: [at(path, element, "HTM-062")], hrefs: [xlink] };
  }
  if (xlink !== undefined && xlink !== href) {
    return { findings: [at(path, element, "HTM-063", xlink, href ?? "")], hrefs: [href, xlink] };
  }
  return { findings: [], hrefs: [href] };
};

export const check = (document: Xml.XmlDocument, path: string) => {
  const findings: Array<Finding> = [];
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    for (const attribute of element.attributes) {
      if (attribute.ns === XMLNS_NS && attribute.local === "epub" && attribute.value !== OPS_NS) {
        findings.push(at(path, element, "HTM-010", attribute.value));
      }
      if (
        attribute.ns === SSML_NS &&
        attribute.local === "ph" &&
        JavaText.trim(attribute.value) === ""
      ) {
        findings.push(at(path, element, "HTM-007"));
      }
    }
    if (element.ns === XHTML_NS) {
      if (DISCOURAGED.has(element.local))
        findings.push(at(path, element, "HTM-055", element.local));
      // Upstream checks a link's title on its lowercased name, and its classes on its name.
      if (element.local.toLowerCase() === "link") findings.push(...linkFindings(path, element));
    } else if (element.ns === SVG_NS && XLINKED.has(element.local.toLowerCase())) {
      findings.push(...svgHrefs(path, element).findings);
    } else if (element.ns === MATHML_NS && element.local === "math") {
      const hasAnnotation = Xml.descendants(element).some(
        (descendant) => descendant.ns === MATHML_NS && descendant.local === "annotation-xml",
      );
      // Upstream checks at the end of the `math` element.
      if (Xml.attribute(element, "alttext") === undefined && !hasAnnotation) {
        findings.push({
          id: "ACC-009",
          args: [],
          path,
          line: element.endLine,
          column: element.endColumn,
        });
      }
    }
  }
  return findings;
};

// HTM-025 for the links upstream's OPSHandler checks in either version: XHTML `a` and `area`, and
// SVG `a`, by its `xlink:href` in EPUB 2 and by both hrefs in EPUB 3.
// Upstream's base is not scoped: a `base` element or `xml:base` attribute applies from its own
// element to the end of the document. Links dispatch on lowercased element names.
export const schemeFindings = (document: Xml.XmlDocument, path: string, version: "2" | "3") => {
  const findings: Array<Finding> = [];
  let base: URL | undefined;
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    const newBase =
      element.ns === XHTML_NS && element.local === "base"
        ? Xml.attribute(element, "href")
        : Xml.attribute(element, "base", XML_NS);
    if (newBase !== undefined) base = resolve(JavaText.stripWhitespace(newBase), base) ?? base;
    const name = element.local.toLowerCase();
    if (element.ns === XHTML_NS && (name === "a" || name === "area")) {
      findings.push(...schemeFinding(path, element, Xml.attribute(element, "href"), base));
    } else if (element.ns === SVG_NS && name === "a") {
      const hrefs =
        version === "3"
          ? svgHrefs(path, element).hrefs
          : [Xml.attribute(element, "href", XLINK_NS)];
      for (const href of hrefs) findings.push(...schemeFinding(path, element, href, base));
    }
  }
  return findings;
};

// Upstream's link checks: an alternate style sheet needs a title (CSS-015), and its alternate
// style tags must not conflict (CSS-005). Link types and tags compare case-sensitively.
const linkFindings = (path: string, link: Xml.XmlElement) => {
  const findings: Array<Finding> = [];
  const rel = Xml.attribute(link, "rel");
  const types = (rel ?? "").split(/[ \t\n\v\f\r]+/);
  const title = Xml.attribute(link, "title");
  if (rel !== undefined && types.includes("alternate") && types.includes("stylesheet")) {
    if (title === undefined || title === "") findings.push(at(path, link, "CSS-015"));
  }
  const classes = Xml.attribute(link, "class");
  if (classes === undefined || link.local !== "link") return findings;
  // The classes are a property list whose only vocabulary is the default one: no prefix is
  // declared, whatever `epub:prefix` says.
  const tokens = classes.split(/[ \t\n\v\f\r]+/).filter((tag) => tag !== "");
  for (const token of tokens) {
    const colon = token.indexOf(":");
    if (colon === 0 || colon === token.length - 1) findings.push(at(path, link, "OPF-026", token));
    else if (colon > 0) findings.push(at(path, link, "OPF-028", token.slice(0, colon)));
  }
  const tags = new Set(tokens);
  if (CONFLICTING_TAGS.some(([first, second]) => tags.has(first) && tags.has(second))) {
    findings.push(at(path, link, "CSS-005", classes));
  }
  return findings;
};

const XHTML11_PUBLIC_ID = "-//W3C//DTD XHTML 1.1//EN";
const XHTML11_SYSTEM_ID = "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd";

// EPUB 2 XHTML documents may only use the XHTML 1.1 DOCTYPE, if any (HTM-004). Upstream
// checks only a DOCTYPE for the `html` root, as written.
export const epub2Doctype = (document: Xml.XmlDocument, path: string) => {
  const doctype = document.doctype;
  const found =
    doctype === undefined || doctype.name !== "html"
      ? undefined
      : doctype.publicId !== XHTML11_PUBLIC_ID
        ? (doctype.publicId ?? "")
        : doctype.systemId !== XHTML11_SYSTEM_ID
          ? (doctype.systemId ?? "")
          : undefined;
  if (doctype === undefined || found === undefined) return [];
  const expected = `<!DOCTYPE html PUBLIC "${XHTML11_PUBLIC_ID}" \n"${XHTML11_SYSTEM_ID}">`;
  return [at(path, doctype, "HTM-004", found, expected)];
};

// Upstream's SVG link names (ACC-011): an `a` inside SVG, XHTML ones included, is named by a
// non-empty `xlink:title` or `aria-label`, or by any SVG `title` or `text` element that starts
// after it. Upstream keeps one flag for the whole document, and checks it at each `a`'s end.
export const svgLinkNames = (document: Xml.XmlDocument, path: string, svgDocument: boolean) => {
  const findings: Array<Finding> = [];
  let inSvg = false;
  let named = false;
  const stack: Array<readonly [Xml.XmlElement, boolean]> = [[document.root, false]];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const [element, closing] = next;
    if (closing) {
      if (element.local === "a" && (inSvg || svgDocument) && !named) {
        findings.push({
          id: "ACC-011",
          args: [],
          path,
          line: element.endLine,
          column: element.endColumn,
        });
      }
      if (element.local === "svg") inSvg = false;
      continue;
    }
    stack.push([element, true]);
    for (const child of Xml.childElements(element).reverse()) stack.push([child, false]);
    const anchor = element.local === "a" && (element.ns === SVG_NS || element.ns === XHTML_NS);
    if (anchor && (inSvg || svgDocument)) {
      named =
        (Xml.attribute(element, "title", XLINK_NS) ?? "") !== "" ||
        (Xml.attribute(element, "aria-label") ?? "") !== "";
    }
    if (element.ns !== SVG_NS) continue;
    if (element.local === "svg") inSvg = true;
    else if (element.local === "title" || element.local === "text") named = true;
  }
  return findings;
};
