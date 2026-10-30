import type { Finding } from "../references/Collect.ts";
import * as Url from "../references/Url.ts";
import * as Xml from "../xml/Xml.ts";

// What `META-INF/encryption.xml` declares, as upstream's OCFEncryptionFileHandler reads it: each
// `CipherReference` names an encrypted resource by a URL against the container root (or an
// `xml:base`), and IDPF font obfuscation is outdated (OBS-001). Upstream decrypts none of them.

const IDPF_OBFUSCATION = "http://www.idpf.org/2008/embedding";
const ADOBE_ENCRYPTION_NS = "http://ns.adobe.com/digitaleditions/enc";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const FILE = "META-INF/encryption.xml";

export interface Position {
  readonly line: number;
  readonly column: number;
}

export const read = (document: Xml.XmlDocument, files: ReadonlySet<string>) => {
  const findings: Array<Finding> = [];
  const encrypted = new Set<string>();
  // Where each obfuscated resource is declared, for PKG-026.
  const obfuscated = new Map<string, Position>();
  const urls = Url.checker("", { container: true });
  // Upstream matches elements by local name, and records an algorithm on the parent of its
  // `EncryptionMethod`, unless that parent is compressed.
  const algorithms = new Map<Xml.XmlElement, string>();
  // Iterative, in document order, with each element's parent and grandparent.
  const stack: Array<
    readonly [Xml.XmlElement, Xml.XmlElement | undefined, Xml.XmlElement | undefined]
  > = [[document.root, undefined, undefined]];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const [element, parent, grandparent] = next;
    for (const child of Xml.childElements(element).reverse()) stack.push([child, element, parent]);
    const at = { path: FILE, line: element.line, column: element.column };
    // A base stays in force after its element ends, as in upstream's BaseURLHandler.
    const base = Xml.attribute(element, "base", XML_NS);
    if (base !== undefined) {
      for (const problem of urls.setBase(base)) findings.push({ ...problem, ...at });
    }
    if (element.local === "EncryptionMethod") {
      const algorithm = Xml.attribute(element, "Algorithm");
      if (algorithm !== undefined && parent !== undefined) {
        if (Xml.attribute(parent, "compression", ADOBE_ENCRYPTION_NS) === undefined) {
          algorithms.set(parent, algorithm);
        }
      }
      continue;
    }
    if (element.local !== "CipherReference") continue;
    const algorithm =
      grandparent?.local === "EncryptedData" ? algorithms.get(grandparent) : undefined;
    const href = Xml.attribute(element, "URI");
    if (href === undefined) continue;
    const { problems, resolved } = urls.check(href);
    for (const problem of problems) findings.push({ ...problem, ...at });
    if (resolved === undefined) continue;
    // A URL with a fragment names no container file.
    const { target, fragment } = resolved;
    if (target.kind !== "local" || fragment !== undefined || !files.has(target.path)) {
      findings.push({ id: "RSC-007", args: [href], ...at });
      continue;
    }
    encrypted.add(target.path);
    if (algorithm === IDPF_OBFUSCATION) {
      obfuscated.set(target.path, { line: at.line, column: at.column });
      findings.push({ id: "OBS-001", args: ["font-obfuscation"], ...at });
    }
  }
  return { findings, encrypted, obfuscated };
};
