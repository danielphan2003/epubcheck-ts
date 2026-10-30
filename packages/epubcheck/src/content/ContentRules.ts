import type { MessageId } from "../messages/MessageCatalog.ts";
import type { Finding } from "../references/Collect.ts";
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
const CONFLICTING_TAGS: ReadonlyArray<readonly [string, string]> = [
  ["day", "night"],
  ["horizontal", "vertical"],
];

// URI schemes registered with IANA (permanent and provisional) that content links use.
const REGISTERED_SCHEMES = new Set([
  "about",
  "acap",
  "acct",
  "attachment",
  "bitcoin",
  "blob",
  "callto",
  "cap",
  "cid",
  "coap",
  "coaps",
  "content",
  "crid",
  "data",
  "dav",
  "dict",
  "dns",
  "doi",
  "dtn",
  "ed2k",
  "facetime",
  "fax",
  "feed",
  "file",
  "finger",
  "fish",
  "ftp",
  "geo",
  "git",
  "go",
  "gopher",
  "h323",
  "http",
  "https",
  "iax",
  "icap",
  "im",
  "imap",
  "info",
  "ipp",
  "ipps",
  "irc",
  "irc6",
  "ircs",
  "iris",
  "isbn",
  "issn",
  "jabber",
  "javascript",
  "ldap",
  "ldaps",
  "magnet",
  "mailto",
  "maps",
  "market",
  "message",
  "mid",
  "mms",
  "modem",
  "ms-help",
  "msrp",
  "msrps",
  "mtqp",
  "mumble",
  "mupdate",
  "news",
  "nfs",
  "nntp",
  "notes",
  "opaquelocktoken",
  "pop",
  "pres",
  "prospero",
  "proxy",
  "redis",
  "rediss",
  "rsync",
  "rtmp",
  "rtsp",
  "rtsps",
  "sftp",
  "sip",
  "sips",
  "skype",
  "smb",
  "sms",
  "snews",
  "snmp",
  "soap.beep",
  "soap.beeps",
  "spotify",
  "ssh",
  "steam",
  "svn",
  "tag",
  "tel",
  "telnet",
  "tftp",
  "tip",
  "tn3270",
  "turn",
  "turns",
  "tv",
  "udp",
  "unreal",
  "urn",
  "uuid",
  "vemmi",
  "videotex",
  "view-source",
  "wais",
  "webcal",
  "ws",
  "wss",
  "xmpp",
  "z39.50r",
  "z39.50s",
]);

const at = (
  path: string,
  element: Xml.XmlElement,
  id: MessageId,
  ...args: ReadonlyArray<string>
): Finding => ({
  id,
  args,
  path,
  line: element.line,
  column: element.column,
});

export const check = (document: Xml.XmlDocument, path: string, kind: "xhtml" | "svg") => {
  const findings: Array<Finding> = [];
  if (document.version !== undefined && document.version !== "1.0") {
    findings.push({ id: "HTM-001", args: [document.version], path, line: -1, column: -1 });
  }
  const doctype = document.doctype;
  if (doctype !== undefined && kind === "xhtml") {
    const where = { path, line: doctype.line, column: doctype.column };
    for (const name of Xml.externalEntityNames(doctype)) {
      findings.push({ id: "HTM-003", args: [name], ...where });
    }
    // Upstream formats a missing public ID with Java's string conversion.
    const legacy = doctype.publicId === undefined && doctype.systemId === "about:legacy-compat";
    if ((doctype.publicId !== undefined || doctype.systemId !== undefined) && !legacy) {
      findings.push({
        id: "HTM-004",
        args: [doctype.publicId ?? "null", "<!DOCTYPE html>"],
        ...where,
      });
    }
  }
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
      if (element.local === "a") {
        const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(
          Xml.attribute(element, "href") ?? "",
        )?.[1];
        if (scheme !== undefined && !REGISTERED_SCHEMES.has(scheme.toLowerCase())) {
          findings.push(at(path, element, "HTM-025"));
        }
      }
    } else if (element.ns === SVG_NS && XLINKED.has(element.local)) {
      const xlink = Xml.attribute(element, "href", XLINK_NS);
      const href = Xml.attribute(element, "href");
      if (xlink !== undefined && href === undefined) findings.push(at(path, element, "HTM-062"));
      else if (xlink !== undefined && href !== undefined && xlink.trim() !== href.trim()) {
        findings.push(at(path, element, "HTM-063", xlink, href));
      }
    } else if (element.ns === MATHML_NS && element.local === "math") {
      const hasAnnotation = Xml.descendants(element).some(
        (descendant) => descendant.ns === MATHML_NS && descendant.local === "annotation-xml",
      );
      if (Xml.attribute(element, "alttext") === undefined && !hasAnnotation) {
        findings.push(at(path, element, "ACC-009"));
      }
    }
  }
  return findings;
};

const linkFindings = (path: string, link: Xml.XmlElement) => {
  const findings: Array<Finding> = [];
  const rel = (Xml.attribute(link, "rel") ?? "").toLowerCase().split(/\s+/);
  if (rel.includes("stylesheet") && rel.includes("alternate")) {
    if ((Xml.attribute(link, "title") ?? "").trim() === "")
      findings.push(at(path, link, "CSS-015"));
  }
  const tags = (Xml.attribute(link, "class") ?? "").split(/\s+/);
  for (const [first, second] of CONFLICTING_TAGS) {
    if (tags.includes(first) && tags.includes(second)) {
      findings.push(at(path, link, "CSS-005", `${first} ${second}`));
    }
  }
  return findings;
};
