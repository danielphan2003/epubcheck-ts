import { keyedSuggestion, type MessageId } from "../messages/MessageCatalog.ts";
import * as Xml from "../xml/Xml.ts";
import { checkLanguageTag } from "./LanguageTag.ts";
import type { ManifestItem, PackageDocument } from "./PackageDocument.ts";
import * as Vocabularies from "./Vocabularies.ts";

// Package document rules that the schemas do not express: manifest and spine integrity,
// fallback chains, identifiers, dates, language tags and links.

const OPF_NS = "http://www.idpf.org/2007/opf";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

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
  const byPath = new Map<string, ManifestItem>();
  const byId = new Map(opf.items.map((item) => [item.id, item] as const));
  for (const item of opf.items) {
    if (item.path !== undefined && byPath.has(item.path)) {
      findings.push(at(item.element, "OPF-074", item.path));
      continue;
    }
    if (item.path !== undefined) byPath.set(item.path, item);
    if (item.path === opf.path) {
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
  // Follow each fallback chain once; a chain returning to an item still being followed is a cycle.
  const state = new Map<string, "visiting" | "done">();
  const follow = (item: ManifestItem) => {
    if (state.get(item.id) !== undefined) return;
    state.set(item.id, "visiting");
    const fallback = (Xml.attribute(item.element, "fallback") ?? "").trim();
    if (fallback !== "") {
      const next = byId.get(fallback);
      if (next === undefined) findings.push(at(item.element, "OPF-040", fallback));
      else if (state.get(next.id) === "visiting") findings.push(at(item.element, "OPF-045"));
      else follow(next);
    }
    state.set(item.id, "done");
  };
  for (const item of opf.items) follow(item);
  return findings;
};

const spineChecks = ({ document, opf }: Context) => {
  const findings: Array<Finding> = [];
  const ids = new Set(opf.items.map((item) => item.id));
  const spine = opfChildren(document.root, "spine")[0];
  const itemrefs = opfChildren(spine, "itemref");
  const seen = new Set<string>();
  let resolved = 0;
  let linear = false;
  for (const itemref of itemrefs) {
    // The schema reports a missing `idref`; the message quotes the value as written.
    const written = Xml.attribute(itemref, "idref");
    if (written === undefined) continue;
    const idref = written.trim();
    if (!ids.has(idref)) {
      findings.push(at(itemref, "OPF-049", written));
      continue;
    }
    resolved++;
    if ((Xml.attribute(itemref, "linear") ?? "").trim() !== "no") linear = true;
    if (opf.version === "2" && seen.has(idref)) findings.push(at(itemref, "OPF-034", idref));
    seen.add(idref);
  }
  if (resolved > 0 && !linear) findings.push(nowhere("OPF-033"));
  return findings;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// W3C date-time (http://www.w3.org/TR/NOTE-datetime); the detail mimics upstream's parser.
const dateProblem = (value: string) => {
  if (value === "") return "zero-length string";
  const datePart = value.split("T")[0] ?? "";
  const [year = "", ...rest] = datePart.split("-");
  if (!/^[+-]?\d+$/.test(year)) return `[For input string: "${year}"] is not an integer.`;
  if (year.length !== 4) return year;
  const full =
    /^\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?)?)?$/;
  if (full.test(value)) {
    const [month, day] = rest.map(Number);
    if (month !== undefined && (month < 1 || month > 12)) return `${month}`;
    if (day !== undefined && (day < 1 || day > 31)) return `${day}`;
    return undefined;
  }
  return value;
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
  if (uniqueIdentifier === undefined || uniqueIdentifier.trim() === "") {
    findings.push(at(root, "OPF-048"));
  } else if (
    container !== undefined &&
    !dcElements("identifier").some(
      (element) => (Xml.attribute(element, "id") ?? "").trim() === uniqueIdentifier.trim(),
    )
  ) {
    findings.push(nowhere("OPF-030", uniqueIdentifier));
  }

  for (const identifier of dcElements("identifier")) {
    const value = Xml.textContent(identifier).trim();
    const scheme = (Xml.attribute(identifier, "scheme", OPF_NS) ?? "").trim().toLowerCase();
    const uuid = value.toLowerCase().startsWith("urn:uuid:")
      ? value.slice(9)
      : opf.version === "2" && scheme === "uuid"
        ? value
        : undefined;
    if (uuid !== undefined && !UUID.test(uuid)) findings.push(at(identifier, "OPF-085", value));
  }

  for (const date of dcElements("date")) {
    const value = Xml.textContent(date).trim();
    const problem = dateProblem(value);
    if (problem !== undefined)
      findings.push(atEnd(date, opf.version === "2" ? "OPF-054" : "OPF-053", value, problem));
  }

  if (opf.version === "3") {
    for (const language of dcElements("language")) {
      const value = Xml.textContent(language);
      // Blank content is the schema's to report.
      const problem = value.trim() === "" ? undefined : checkLanguageTag(value);
      if (problem !== undefined) findings.push(atEnd(language, "OPF-092", value, problem));
    }
    for (const element of [root, ...Xml.descendants(root)]) {
      const lang = Xml.attribute(element, "lang", XML_NS);
      const problem = lang === undefined || lang === "" ? undefined : checkLanguageTag(lang);
      if (lang !== undefined && problem !== undefined)
        findings.push(at(element, "OPF-092", lang, problem));
    }
    for (const link of opfChildren(metadata, "link")) {
      const hreflang = Xml.attribute(link, "hreflang");
      const problem =
        hreflang === undefined || hreflang === "" ? undefined : checkLanguageTag(hreflang);
      if (hreflang !== undefined && problem !== undefined)
        findings.push(at(link, "OPF-092", hreflang, problem));
      const href = (Xml.attribute(link, "href") ?? "").trim();
      if (href.startsWith("#")) findings.push(at(link, "OPF-098", href));
      else if (
        href !== "" &&
        !isRemote(href) &&
        Xml.attribute(link, "media-type") === undefined &&
        !/(?:^|\s)(?:record|voicing)(?:\s|$)/.test(Xml.attribute(link, "rel") ?? "")
      ) {
        findings.push(at(link, "OPF-093"));
      }
    }
    if (metadata !== undefined && hasRefinesCycle(metadata))
      findings.push(atEnd(metadata, "OPF-065"));
  }
  return findings;
};

const hasRefinesCycle = (metadata: Xml.XmlElement) => {
  const refines = new Map<string, string>();
  for (const element of Xml.descendants(metadata)) {
    const id = (Xml.attribute(element, "id") ?? "").trim();
    const target = (Xml.attribute(element, "refines") ?? "").trim();
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

const problemsAt = (element: Xml.XmlElement, problems: ReadonlyArray<Vocabularies.Problem>) =>
  problems.map((problem) =>
    problem.id === "OPF-086"
      ? at(
          element,
          problem.id,
          problem.args[0] ?? "",
          keyedSuggestion("OPF-086", problem.args[1] ?? ""),
        )
      : at(element, problem.id, ...problem.args),
  );

// Property attributes, prefixes, links and outdated features (EPUB 3 only).
const vocabularyChecks = ({ document }: Context) => {
  const findings: Array<Finding> = [];
  const root = document.root;
  const prefixes = Vocabularies.parsePrefixes(Xml.attribute(root, "prefix"));
  findings.push(...problemsAt(root, prefixes.problems));
  const property = (
    element: Xml.XmlElement,
    attribute: string,
    context: Vocabularies.PropertyContext,
    isList: boolean,
  ) => {
    const parsed = Vocabularies.parseProperties(
      Xml.attribute(element, attribute),
      context,
      prefixes,
      isList,
    );
    findings.push(...problemsAt(element, parsed.problems));
    return parsed.properties;
  };
  const metadata = opfChildren(root, "metadata")[0];
  for (const meta of opfChildren(metadata, "meta")) {
    if (
      Xml.attribute(meta, "property") === undefined &&
      Xml.attribute(meta, "name") !== undefined
    ) {
      findings.push(at(meta, "OBS-001", "element", 'OPF 2 "meta"'));
      continue;
    }
    property(meta, "property", "meta", false);
    property(meta, "scheme", "scheme", false);
  }
  for (const link of opfChildren(metadata, "link")) {
    const rels = property(link, "rel", "link-rel", true).map((parsed) => parsed.token);
    property(link, "properties", "link", true);
    const mediaType = Xml.attribute(link, "media-type");
    if (rels.includes("alternate") && rels.length > 1) findings.push(at(link, "OPF-089"));
    for (const rel of ["record", "voicing"]) {
      if (rels.includes(rel) && mediaType === undefined) findings.push(at(link, "OPF-094", rel));
    }
    if (
      rels.includes("voicing") &&
      mediaType !== undefined &&
      !mediaType.trim().startsWith("audio/")
    ) {
      findings.push(at(link, "OPF-095", mediaType));
    }
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
