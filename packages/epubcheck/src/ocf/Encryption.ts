import type { Finding } from "../references/Collect.ts";
import * as Url from "../references/Url.ts";
import * as Xml from "../xml/Xml.ts";

// What `META-INF/encryption.xml` declares, as upstream's OCFEncryptionFileHandler reads it: each
// `CipherReference` names an encrypted resource by a URL against the container root, and IDPF
// font obfuscation is outdated (OBS-001). Upstream can decrypt none of them.

const IDPF_OBFUSCATION = "http://www.idpf.org/2008/embedding";
const ADOBE_ENCRYPTION_NS = "http://ns.adobe.com/digitaleditions/enc";
const FILE = "META-INF/encryption.xml";

export const read = (document: Xml.XmlDocument, files: ReadonlySet<string>) => {
  const findings: Array<Finding> = [];
  const encrypted = new Set<string>();
  // Where each obfuscated resource is declared, for PKG-026.
  const obfuscated = new Map<string, { readonly line: number; readonly column: number }>();
  const urls = Url.checker("", { container: true });
  // Upstream matches elements by local name, and records an algorithm on the parent of its
  // `EncryptionMethod`, unless that parent is compressed.
  const algorithms = new Map<Xml.XmlElement, string>();
  const parents = new Map<Xml.XmlElement, Xml.XmlElement>();
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    for (const child of Xml.childElements(element)) parents.set(child, element);
  }
  for (const element of Xml.descendants(document.root)) {
    const parent = parents.get(element);
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
    const data = parent === undefined ? undefined : parents.get(parent);
    const algorithm = data?.local === "EncryptedData" ? algorithms.get(data) : undefined;
    const href = Xml.attribute(element, "URI");
    if (href === undefined) continue;
    const at = { path: FILE, line: element.line, column: element.column };
    const { problems, resolved } = urls.check(href);
    for (const problem of problems) findings.push({ ...problem, ...at });
    if (resolved === undefined) continue;
    const { target } = resolved;
    if (target.kind !== "local" || !files.has(target.path)) {
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
