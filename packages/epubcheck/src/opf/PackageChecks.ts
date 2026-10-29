import { keyedSuggestion, type MessageId } from "../messages/MessageCatalog.ts";
import * as Xml from "../xml/Xml.ts";
import { checkLanguageTag } from "./LanguageTag.ts";
import type { ManifestItem, PackageDocument } from "./PackageDocument.ts";
import * as Vocabularies from "./Vocabularies.ts";
import * as W3cDate from "./W3cDate.ts";

// Package document rules that the schemas do not express: manifest and spine integrity,
// fallback chains, identifiers, dates, language tags and links.

const OPF_NS = "http://www.idpf.org/2007/opf";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
// Container paths resolve against this base, so a URL's origin tells local from remote.
const CONTAINER = new URL("https://container.invalid/");

export interface Finding {
  readonly id: MessageId;
  readonly args: ReadonlyArray<string>;
  // Where to report; `path` overrides the package document path (RSC-001 points at the file).
  readonly line: number;
  readonly column: number;
  readonly path?: string | undefined;
}

export interface Context {
  readonly document: Xml.XmlDocument;
  readonly opf: PackageDocument;
  // Container file paths in a full publication check; undefined when checking the file alone.
  readonly container: ReadonlySet<string> | undefined;
}

const at = (element: Xml.XmlElement, id: MessageId, ...args: ReadonlyArray<string>): Finding => ({
  id,
  args,
  line: element.line,
  column: element.column,
});

const atEnd = (
  element: Xml.XmlElement,
  id: MessageId,
  ...args: ReadonlyArray<string>
): Finding => ({
  id,
  args,
  line: element.endLine,
  column: element.endColumn,
});

const nowhere = (id: MessageId, ...args: ReadonlyArray<string>): Finding => ({
  id,
  args,
  line: -1,
  column: -1,
});

const isRemote = (href: string) =>
  /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !href.startsWith("data:");

const opfChildren = (element: Xml.XmlElement | undefined, local: string) =>
  element === undefined
    ? []
    : Xml.childElements(element).filter((child) => child.ns === OPF_NS && child.local === local);

const ITEM_PROPERTY_TYPES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "cover-image": ["image/"],
  "data-nav": ["application/xhtml+xml"],
  dictionary: ["application/vnd.epub.search-key-map+xml"],
  glossary: ["application/vnd.epub.search-key-map+xml", "application/xhtml+xml"],
  index: ["application/xhtml+xml"],
  mathml: ["application/xhtml+xml", "image/svg+xml"],
  nav: ["application/xhtml+xml"],
  "remote-resources": [
    "application/xhtml+xml",
    "application/smil+xml",
    "image/svg+xml",
    "text/css",
  ],
  scripted: ["application/xhtml+xml", "image/svg+xml"],
  "search-key-map": ["application/vnd.epub.search-key-map+xml"],
  svg: ["application/xhtml+xml"],
  switch: ["application/xhtml+xml", "image/svg+xml"],
};

const allowedFor = (property: string, mediaType: string) => {
  const types = ITEM_PROPERTY_TYPES[property];
  if (types === undefined) return true;
  return types.some((type) =>
    type.endsWith("/") ? mediaType.startsWith(type) : type === mediaType,
  );
};

const manifestChecks = ({ opf, container }: Context) => {
  const findings: Array<Finding> = [];
  // Container names and hrefs may use different Unicode normalization forms for the same name.
  const files =
    container === undefined
      ? undefined
      : new Set([...container].map((file) => file.normalize("NFC")));
  const byId = new Map(opf.items.map((item) => [item.id, item] as const));
  // Upstream identifies items by URL, with the fragment but, inside the container, without the
  // query. The last item for a URL is the one it keeps and checks; every other one is a duplicate.
  const packageUrl = new URL(opf.path, CONTAINER);
  const urlOf = (item: ManifestItem) => {
    const url = URL.parse(item.href, packageUrl);
    if (url?.origin === CONTAINER.origin) url.search = "";
    return url?.href;
  };
  const kept = new Map(opf.items.map((item) => [urlOf(item), item] as const));
  for (const item of opf.items) {
    const url = urlOf(item);
    if (kept.get(url) !== item) {
      findings.push(at(item.element, "OPF-074", item.path ?? url ?? item.href));
      continue;
    }
    if (url === packageUrl.href) {
      findings.push(at(item.element, "OPF-099"));
      continue;
    }
    if (opf.version === "3") {
      if (item.href.includes("#")) findings.push(at(item.element, "OPF-091"));
      for (const property of item.properties) {
        if (!allowedFor(property, item.mediaType))
          findings.push(at(item.element, "OPF-012", property, item.mediaType));
      }
    }
    if (
      files !== undefined &&
      item.path !== undefined &&
      !isRemote(item.href) &&
      !files.has(item.path.normalize("NFC"))
    ) {
      findings.push({ id: "RSC-001", args: [item.path], line: -1, column: -1, path: item.path });
    }
  }
  const fallbackOf = (item: ManifestItem) => (Xml.attribute(item.element, "fallback") ?? "").trim();
  for (const item of opf.items) {
    const fallback = fallbackOf(item);
    if (fallback !== "" && !byId.has(fallback))
      findings.push(at(item.element, "OPF-040", fallback));
  }
  // Upstream's worklist: an item resolves without a fallback, with a missing one, or through a
  // resolved one, and goes to the back of the queue otherwise. Once a full pass makes no progress,
  // the item at the front is reported, once.
  const resolved = new Set<string>();
  // Upstream keys items by ID: a repeated ID keeps its first position with the last item.
  const queue = [...byId.values()];
  for (let stalled = 0; queue.length > 0 && stalled <= queue.length;) {
    const item = queue.shift();
    if (item === undefined) break;
    const fallback = fallbackOf(item);
    const target = fallback === "" ? undefined : byId.get(fallback);
    if (target !== undefined && !resolved.has(target.id)) {
      queue.push(item);
      stalled++;
    } else {
      resolved.add(item.id);
      stalled = 0;
    }
  }
  const unresolved = queue[0];
  if (unresolved !== undefined) findings.push(at(unresolved.element, "OPF-045"));
  return findings;
};

const spineChecks = ({ document, opf }: Context) => {
  const findings: Array<Finding> = [];
  const items = new Map(opf.items.map((item) => [item.id, item] as const));
  const spine = opfChildren(document.root, "spine")[0];
  const itemrefs = opfChildren(spine, "itemref");
  const seen = new Set<string>();
  // Upstream marks a manifest item non-linear for any `linear="no"` reference, and never back.
  const linear = new Map<string, boolean>();
  for (const itemref of itemrefs) {
    // The schema reports a missing `idref`; the message quotes the value as written.
    const written = Xml.attribute(itemref, "idref");
    if (written === undefined) continue;
    const idref = written.trim();
    const item = items.get(idref);
    if (item === undefined) {
      findings.push(at(itemref, "OPF-049", written));
      continue;
    }
    const isLinear = (Xml.attribute(itemref, "linear") ?? "").trim() !== "no";
    linear.set(idref, isLinear && linear.get(idref) !== false);
    // Upstream reports a repeated reference at the manifest item.
    if (opf.version === "2" && seen.has(idref)) findings.push(at(item.element, "OPF-034", idref));
    seen.add(idref);
  }
  if (linear.size > 0 && ![...linear.values()].includes(true)) findings.push(nowhere("OPF-033"));
  return findings;
};

// java.util.UUID.fromString: five dash-separated hexadecimal numbers that each fit a signed
// long, 36 characters at most.
const isJavaUuid = (value: string) => {
  const parts = value.split("-");
  return (
    value.length <= 36 &&
    parts.length === 5 &&
    parts.every((part) => {
      const digits = part.replace(/^\+/, "").replace(/^0+(?=.)/, "");
      return (
        /^[0-9a-fA-F]+$/.test(digits) &&
        (digits.length < 16 || (digits.length === 16 && /^[0-7]/.test(digits)))
      );
    })
  );
};

const metadataChecks = ({ document, opf, container }: Context) => {
  const findings: Array<Finding> = [];
  const root = document.root;
  const metadata = opfChildren(root, "metadata")[0];
  const dcElements = (local: string) =>
    metadata === undefined
      ? []
      : [...Xml.descendants(metadata)].filter(
          (element) => element.ns === DC_NS && element.local === local,
        );

  const uniqueIdentifier = Xml.attribute(root, "unique-identifier");
  if (uniqueIdentifier === undefined || uniqueIdentifier === "") findings.push(at(root, "OPF-048"));
  // Upstream matches each identifier's trimmed `id` against the attribute as written.
  const unique = dcElements("identifier").find((element) => {
    const id = Xml.attribute(element, "id");
    return id !== undefined && id !== "" && id.trim() === uniqueIdentifier;
  });
  if (unique === undefined && container !== undefined) {
    findings.push(nowhere("OPF-030", uniqueIdentifier ?? "null"));
  }
  if (unique !== undefined) {
    const value = Xml.textContent(unique).trim();
    const scheme = Xml.attribute(unique, "scheme", OPF_NS)?.toLowerCase();
    if (
      (value.startsWith("urn:uuid:") || scheme === "uuid") &&
      !isJavaUuid(value.replaceAll("urn:uuid:", ""))
    ) {
      findings.push(atEnd(unique, "OPF-085", value));
    }
  }

  for (const date of dcElements("date")) {
    const value = Xml.textContent(date);
    const problem = W3cDate.problem(value);
    if (problem !== undefined)
      findings.push(atEnd(date, opf.version === "2" ? "OPF-054" : "OPF-053", value, problem));
  }

  if (opf.version === "3") {
    for (const language of dcElements("language")) {
      const value = Xml.textContent(language).trim();
      // Blank content is the schema's to report.
      const problem = value === "" ? undefined : checkLanguageTag(value);
      if (problem !== undefined) findings.push(atEnd(language, "OPF-092", value, problem));
    }
    for (const element of [root, ...Xml.descendants(root)]) {
      const lang = Xml.attribute(element, "lang", XML_NS);
      const problem = lang === undefined || lang === "" ? undefined : checkLanguageTag(lang);
      if (lang !== undefined && problem !== undefined)
        findings.push(at(element, "OPF-092", lang, problem));
    }
    if (metadata !== undefined && hasRefinesCycle(metadata))
      findings.push(atEnd(metadata, "OPF-065"));
  }
  return findings;
};

// Upstream follows `refines` between `meta` elements only, with the attribute as written.
const hasRefinesCycle = (metadata: Xml.XmlElement) => {
  const refines = new Map<string, string>();
  for (const element of opfChildren(metadata, "meta")) {
    const id = Xml.attribute(element, "id") ?? "";
    const target = Xml.attribute(element, "refines") ?? "";
    if (id !== "" && target.startsWith("#")) refines.set(id, target.slice(1));
  }
  for (const start of refines.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = refines.get(current);
    }
  }
  return false;
};

const problemsAt = (
  element: Xml.XmlElement,
  problems: ReadonlyArray<Vocabularies.Problem>,
  locate = at,
) =>
  problems.map((problem) =>
    problem.id === "OPF-086"
      ? locate(
          element,
          problem.id,
          problem.args[0] ?? "",
          keyedSuggestion("OPF-086", problem.args[1] ?? ""),
        )
      : locate(element, problem.id, ...problem.args),
  );

// Property attributes, prefixes, links and outdated features (EPUB 3 only).
const vocabularyChecks = ({ document, opf }: Context) => {
  const findings: Array<Finding> = [];
  const root = document.root;
  const prefixes = Vocabularies.parsePrefixes(Xml.attribute(root, "prefix"));
  findings.push(...problemsAt(root, prefixes.problems));
  const property = (
    element: Xml.XmlElement,
    attribute: string,
    context: Vocabularies.PropertyContext,
    isList: boolean,
    locate = at,
  ) => {
    const parsed = Vocabularies.parseProperties(
      Xml.attribute(element, attribute),
      context,
      prefixes,
      isList,
    );
    findings.push(...problemsAt(element, parsed.problems, locate));
    return parsed.properties;
  };
  const metadata = opfChildren(root, "metadata")[0];
  for (const meta of opfChildren(metadata, "meta")) {
    if (Xml.attribute(meta, "name") !== undefined) {
      findings.push(at(meta, "OBS-001", "element", 'OPF 2 "meta"'));
      continue;
    }
    // Upstream checks a `meta` at its end tag.
    property(meta, "property", "meta", false, atEnd);
    property(meta, "scheme", "scheme", false, atEnd);
  }
  // Upstream's link checks, in its order: a data URL or a link into the package document itself
  // stops there, and an unparsable URL skips to the language tag.
  const packageUrl = new URL(opf.path, CONTAINER);
  for (const link of opfChildren(metadata, "link")) {
    const href = Xml.attribute(link, "href") ?? "";
    const url = URL.parse(href, packageUrl);
    if (url?.protocol === "data:") continue;
    if (url !== null && url.hash.length > 1 && url.href.split("#")[0] === packageUrl.href) {
      findings.push(at(link, "OPF-098", href));
      continue;
    }
    if (url !== null) {
      const parsedRels = property(link, "rel", "link-rel", true);
      const rels = new Set(
        parsedRels.filter((parsed) => parsed.prefix === "").map((parsed) => parsed.name),
      );
      // Any other relation, prefixed ones included, conflicts with `alternate`.
      const relCount = new Set(parsedRels.map((parsed) => parsed.token)).size;
      if (rels.has("alternate") && relCount > 1) findings.push(at(link, "OPF-089"));
      const mediaType = Xml.attribute(link, "media-type");
      if (mediaType === undefined) {
        if (url.origin === CONTAINER.origin) findings.push(at(link, "OPF-093"));
        else if (rels.has("record") || rels.has("voicing"))
          findings.push(at(link, "OPF-094", Xml.attribute(link, "rel") ?? ""));
      } else if (rels.has("voicing") && !mediaType.startsWith("audio/")) {
        findings.push(at(link, "OPF-095", mediaType));
      }
      property(link, "properties", "link", true);
    }
    const hreflang = Xml.attribute(link, "hreflang");
    const problem =
      hreflang === undefined || hreflang === "" ? undefined : checkLanguageTag(hreflang);
    if (hreflang !== undefined && problem !== undefined)
      findings.push(at(link, "OPF-092", hreflang, problem));
  }
  for (const item of opfChildren(opfChildren(root, "manifest")[0], "item"))
    property(item, "properties", "item", true);
  for (const itemref of opfChildren(opfChildren(root, "spine")[0], "itemref")) {
    property(itemref, "properties", "itemref", true);
  }
  const guide = opfChildren(root, "guide")[0];
  if (guide !== undefined) findings.push(at(guide, "OBS-001", "element", 'OPF 2 "guide"'));
  for (const collection of [...Xml.descendants(root)].filter(
    (element) => element.ns === OPF_NS && element.local === "collection",
  )) {
    findings.push(at(collection, "OBS-001", "element", '"collection"'));
  }
  return findings;
};

export const check = (context: Context) => [
  ...(context.opf.version === "3" ? vocabularyChecks(context) : []),
  ...metadataChecks(context),
  ...manifestChecks(context),
  ...spineChecks(context),
];
