import { isNCName } from "../schema/Datatypes.ts";
import type { Finding } from "../schema/Nvdl.ts";
import type * as Xml from "../xml/Xml.ts";

// Upstream rewrites EPUB 3 content before schema validation (its PreprocessingDefaultHandler):
// custom elements move to the Nu checker's namespace, `data-*` and custom-namespace attributes
// are dropped, and case-insensitive HTML attribute values are lowercased.

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const CUSTOM_ELEMENTS_NS = "http://n.validator.nu/custom-elements/";

const KNOWN_NAMESPACES = new Set([
  XHTML_NS,
  "http://www.w3.org/XML/1998/namespace",
  "http://www.idpf.org/2007/ops",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/2001/10/synthesis",
  "http://www.w3.org/2001/xml-events",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/2000/xmlns/",
]);

const CASE_INSENSITIVE = new Set(
  (
    "align allowfullscreen allowpaymentrequest allowusermedia async autocapitalize autocomplete " +
    "autofocus autoplay checked contenteditable controls crossorigin default defer dir disabled " +
    "draggable formnovalidate hidden http-equiv ismap itemscope kind loop multiple muted nomodule " +
    "novalidate open playsinline preload readonly required reversed scope selected shape sizes " +
    "spellcheck step translate type typemustmatch valign value wrap"
  ).split(" "),
);

const reservedHost = (namespace: string) => {
  try {
    const host = new URL(namespace).host;
    if (host.includes("w3.org")) return "w3.org";
    if (host.includes("idpf.org")) return "idpf.org";
  } catch {
    return undefined;
  }
  return undefined;
};

export const preprocess = (document: Xml.XmlDocument, kind: "xhtml" | "svg") => {
  const findings: Array<Finding> = [];
  const visit = (element: Xml.XmlElement): Xml.XmlElement => {
    const attributes = element.attributes.flatMap((attribute): ReadonlyArray<Xml.XmlAttribute> => {
      if (attribute.ns === "" && attribute.local.startsWith("data-")) {
        const name = attribute.local.slice(5);
        if (name === "" || !isNCName(name) || /[A-Z]/.test(name)) {
          findings.push({
            id: "HTM-061",
            line: element.line,
            column: element.column,
            args: [attribute.local],
          });
        }
        return [];
      }
      if (
        kind === "xhtml" &&
        attribute.ns.trim() !== "" &&
        !KNOWN_NAMESPACES.has(attribute.ns.trim())
      ) {
        const reserved = reservedHost(attribute.ns);
        if (reserved !== undefined) {
          findings.push({
            id: "HTM-054",
            line: element.line,
            column: element.column,
            args: [attribute.ns, reserved],
          });
        }
        return [];
      }
      if (
        kind === "xhtml" &&
        element.ns === XHTML_NS &&
        attribute.ns === "" &&
        CASE_INSENSITIVE.has(attribute.local)
      ) {
        return [{ ...attribute, value: attribute.value.toLowerCase() }];
      }
      return [attribute];
    });
    const custom = kind === "xhtml" && element.ns === XHTML_NS && element.local.includes("-");
    return {
      ...element,
      ns: custom ? CUSTOM_ELEMENTS_NS : element.ns,
      attributes,
      children: element.children.map((child) => (child.kind === "text" ? child : visit(child))),
    };
  };
  return { document: { ...document, root: visit(document.root) }, findings };
};
