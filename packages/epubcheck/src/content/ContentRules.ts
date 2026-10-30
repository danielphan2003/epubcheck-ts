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
  element: Xml.XmlElement,
  id: MessageId,
  ...args: ReadonlyArray<string>
) => ({
  id,
  args,
  path,
  line: element.line,
  column: element.column,
});

// URL schemes galimatias parses strictly; it fails on their invalid hosts, but not on ports.
const SPECIAL_SCHEMES = new Set(["ftp", "file", "gopher", "http", "https", "ws", "wss"]);
const PORT = /^([^:]+:\/\/(?:[^@/?#]*@)?(?:\[[^\]]*\]|[^:/?#]*)):[^/?#]*/;

// Upstream's checkHRef: a link to an absolute URL outside the container needs a scheme upstream
// knows (HTM-025); blank links and `.` are checked elsewhere.
const schemeFinding = (path: string, element: Xml.XmlElement, href: string | undefined) => {
  const value = JavaText.trim(href ?? "");
  if (value === "" || value === ".") return [];
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined || REGISTERED_SCHEMES.has(scheme)) return [];
  if (SPECIAL_SCHEMES.has(scheme) && !URL.canParse(value.replace(PORT, "$1"))) return [];
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

// Upstream's DeclarationHandler: in EPUB 3, external entities are not allowed, an `html` DOCTYPE
// is the HTML5 one, and other DOCTYPEs are left to the media type checks.
const doctypeFindings = (doctype: Xml.XmlDoctype, path: string, kind: "xhtml" | "svg") => {
  const findings: Array<Finding> = [];
  const isHtml = kind === "xhtml" && doctype.name.toLowerCase() === "html";
  const legacy = doctype.publicId === undefined && doctype.systemId === "about:legacy-compat";
  if (isHtml && (doctype.publicId !== undefined || doctype.systemId !== undefined) && !legacy) {
    // Upstream formats a missing public ID with Java's string conversion.
    const args = [doctype.publicId ?? "null", "<!DOCTYPE html>"];
    findings.push({ id: "HTM-004", args, path, line: doctype.line, column: doctype.column });
  }
  for (const entity of doctype.externalEntities) {
    findings.push({
      id: "HTM-003",
      args: [entity.name],
      path,
      line: entity.line,
      column: entity.column,
    });
  }
  return findings;
};

export const check = (document: Xml.XmlDocument, path: string, kind: "xhtml" | "svg") => {
  const findings: Array<Finding> = [];
  if (document.doctype !== undefined)
    findings.push(...doctypeFindings(document.doctype, path, kind));
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    for (const attribute of element.attributes) {
      if (attribute.ns === XMLNS_NS && attribute.local === "epub" && attribute.value !== OPS_NS) {
        findings.push(at(path, element, "HTM-010", attribute.value));
      }
      if (attribute.ns === SSML_NS && attribute.local === "ph" && attribute.value.trim() === "") {
        findings.push(at(path, element, "HTM-007"));
      }
    }
    if (element.ns === XHTML_NS) {
      if (DISCOURAGED.has(element.local))
        findings.push(at(path, element, "HTM-055", element.local));
      if (element.local === "link") findings.push(...linkFindings(path, element));
    } else if (element.ns === SVG_NS && XLINKED.has(element.local)) {
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
export const schemeFindings = (document: Xml.XmlDocument, path: string, version: "2" | "3") => {
  const findings: Array<Finding> = [];
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    if (element.ns === XHTML_NS && (element.local === "a" || element.local === "area")) {
      findings.push(...schemeFinding(path, element, Xml.attribute(element, "href")));
    } else if (element.ns === SVG_NS && element.local === "a") {
      const hrefs =
        version === "3"
          ? svgHrefs(path, element).hrefs
          : [Xml.attribute(element, "href", XLINK_NS)];
      for (const href of hrefs) findings.push(...schemeFinding(path, element, href));
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
  const tags = new Set((classes ?? "").split(/[ \t\n\v\f\r]+/).filter((tag) => tag !== ""));
  if (
    classes !== undefined &&
    CONFLICTING_TAGS.some(([first, second]) => tags.has(first) && tags.has(second))
  ) {
    findings.push(at(path, link, "CSS-005", classes));
  }
  return findings;
};
