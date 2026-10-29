import { keyedSuggestion, type MessageId } from "../messages/MessageCatalog.ts";
import * as JavaText from "../util/JavaText.ts";
import { parse as parseFragment, percentDecode } from "../util/UrlFragment.ts";
import * as Xml from "../xml/Xml.ts";
import * as Url from "../references/Url.ts";
import * as FixedLayout from "../layout/FixedLayout.ts";
import * as FilenameChecker from "../ocf/FilenameChecker.ts";
import * as MediaTypes from "../resources/MediaTypes.ts";
import * as ClockValue from "../util/ClockValue.ts";
import { checkLanguageTag } from "./LanguageTag.ts";
import * as Fallbacks from "./Fallbacks.ts";
import { MARC_RELATORS } from "./MarcRelators.ts";
import {
  type Collection,
  type ManifestItem,
  OEB_PACKAGE_NS,
  OPF_NS,
  PACKAGE_NAMESPACES,
  type PackageDocument,
  declaredPaths,
  registered,
  resolve,
} from "./PackageDocument.ts";
import * as JavaDigits from "./JavaDigits.ts";
import * as Vocabularies from "./Vocabularies.ts";
import * as W3cDate from "./W3cDate.ts";

// Package document rules that the schemas do not express: manifest and spine integrity,
// fallback chains, identifiers, dates, language tags and links.

const DC_NS = "http://purl.org/dc/elements/1.1/";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
// Container paths resolve against this base, so a URL's origin tells local from remote.
const CONTAINER = new URL("https://container.invalid/");

// Upstream compares URLs normalized: the path percent-decoded (invalid UTF-8 as U+FFFD) and in
// NFC, unreserved escapes in the fragment decoded, and no query inside the container.
const normalizedUrl = (href: string, base: URL) => {
  const url = URL.parse(href, base);
  if (url === null) return undefined;
  const search = url.origin === CONTAINER.origin ? "" : url.search;
  const hash = url.hash.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9._~-]/.test(char) ? char : escape;
  });
  const path = percentDecode(url.pathname).normalize("NFC");
  return `${url.protocol}//${url.host}${path}${search}${hash}`;
};

// Upstream checks a normalized media type against a pattern in which `+-^` is a range, so a
// quoted parameter value fails it.
export const ITEM_MEDIA_TYPE = /^[a-zA-Z0-9!#$&+-^_]+\/[a-zA-Z0-9!#$&+-^_]+$/;

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

export const at = (
  element: Xml.XmlElement,
  id: MessageId,
  ...args: ReadonlyArray<string>
): Finding => ({
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

// The package metadata, then that of each collection, which upstream checks the same way.
const metadataElements = (root: Xml.XmlElement) => [
  ...opfChildren(root, "metadata").slice(0, 1),
  ...[...Xml.descendants(root)]
    .filter((element) => element.ns === OPF_NS && element.local === "collection")
    .flatMap((collection) => opfChildren(collection, "metadata").slice(0, 1)),
];

// Data URLs are not allowed as EPUB 3 package document hrefs.
const urlSchemeFindings = (element: Xml.XmlElement, href: string, version: "2" | "3") =>
  version === "3" && /^data:/i.test(href) ? [at(element, "RSC-029")] : [];

// Upstream checks URLs as it parses the package document, in document order: EPUB 3 links,
// items with an ID, and guide references. Once one is absolute, the checker stops reporting
// queries and leaks (RSC-033, RSC-026). Each element's problems go with its other checks.
const urlProblems = ({ document, opf, container }: Context) => {
  const urls = Url.checker(opf.path, { container: container !== undefined });
  const problems = new Map<Xml.XmlElement, ReadonlyArray<Finding>>();
  for (const element of Xml.descendants(document.root)) {
    const href = Xml.attribute(element, "href");
    if (element.ns !== OPF_NS || href === undefined) continue;
    const checked =
      element.local === "reference" ||
      (element.local === "link" && opf.version === "3") ||
      (element.local === "item" && Xml.attribute(element, "id") !== undefined);
    if (!checked) continue;
    const found = urls.check(href).problems.map(({ id, args }) => at(element, id, ...args));
    problems.set(element, found);
  }
  return problems;
};

const problemsOf = (urls: ReadonlyMap<Xml.XmlElement, ReadonlyArray<Finding>>, local: string) =>
  [...urls].flatMap(([element, problems]) => (element.local === local ? problems : []));

// What the checks share: URL problems by element, and container files in NFC (names and hrefs
// may use different normalization forms for the same name).
const shared = (context: Context) => ({
  urls: urlProblems(context),
  files:
    context.container === undefined
      ? undefined
      : new Set([...context.container].map((file) => file.normalize("NFC"))),
});

type Checks = Context & ReturnType<typeof shared>;

const opfChildren = (element: Xml.XmlElement | undefined, local: string) =>
  element === undefined
    ? []
    : Xml.childElements(element).filter(
        (child) => PACKAGE_NAMESPACES.has(child.ns) && child.local === local,
      );

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

// Upstream identifies items by normalized URL, fragment included. The last item for a URL is the
// one it keeps and checks; every other one is a duplicate. An item without one is skipped.
// Items are held by ID first: a repeated ID keeps its first position with the last item, and
// items without an ID are left to the schema.
const itemUrls = (opf: PackageDocument) => {
  const packageUrl = new URL(opf.path, CONTAINER);
  const packageKey = normalizedUrl(packageUrl.href, packageUrl);
  const urlOf = (item: ManifestItem) =>
    Xml.attribute(item.element, "href") === undefined
      ? undefined
      : normalizedUrl(item.href, packageUrl);
  const items = [...registered(opf)];
  const kept = new Map(items.map((item) => [urlOf(item), item] as const));
  return { items, urlOf, kept, packageKey };
};

// The items upstream's checkItem sees: neither duplicates nor the package document.
export const checkedItems = (opf: PackageDocument) => {
  const { items, urlOf, kept, packageKey } = itemUrls(opf);
  return items.filter((item) => {
    const url = urlOf(item);
    return url !== undefined && kept.get(url) === item && url !== packageKey;
  });
};

const manifestChecks = ({ opf, container, urls, files }: Checks) => {
  const findings: Array<Finding> = [...problemsOf(urls, "item")];
  const byId = new Map(opf.items.map((item) => [item.id, item] as const));
  const { items, urlOf, kept, packageKey } = itemUrls(opf);
  const toc = items.find((item) => item.id === opf.toc);
  const unreadableToc = toc?.mediaType === "application/x-dtbncx+xml" ? undefined : toc;
  for (const item of items) {
    const url = urlOf(item);
    if (url === undefined) continue;
    // A package document checked alone checks its local items' file names, duplicates included;
    // a full check reports them from the container.
    if (container === undefined && item.path !== undefined && !isRemote(item.href)) {
      for (const finding of FilenameChecker.checkFilename(item.path, opf.version)) {
        findings.push(at(item.element, finding.id, ...finding.args));
      }
    }
    // Upstream looks every item up in the container, duplicates included, but for one it fails
    // to read as the NCX (CHK-008).
    if (
      files !== undefined &&
      item !== unreadableToc &&
      item.path !== undefined &&
      !isRemote(item.href) &&
      !files.has(item.path.normalize("NFC"))
    ) {
      findings.push({ id: "RSC-001", args: [item.path], line: -1, column: -1, path: item.path });
    }
    if (kept.get(url) !== item) {
      // Upstream quotes the item's path, with its normalized fragment in a full publication.
      const fragment = files !== undefined && url.includes("#") ? url.slice(url.indexOf("#")) : "";
      findings.push(
        at(item.element, "OPF-074", item.path === undefined ? url : item.path + fragment),
      );
      continue;
    }
    if (url === packageKey) {
      findings.push(at(item.element, "OPF-099"));
      continue;
    }
    // Upstream's checkItem: a data URL stops it, and only a media type it can parse is checked
    // for a preferred type (OPF-090) and, locally, a fragment (OPF-091).
    const schemeFindings = urlSchemeFindings(item.element, item.href, opf.version);
    findings.push(...schemeFindings);
    if (opf.version === "3" && item.path?.startsWith("META-INF/") === true) {
      findings.push(at(item.element, "PKG-025"));
    }
    if (opf.version === "3" && schemeFindings.every((finding) => finding.id !== "RSC-029")) {
      if (ITEM_MEDIA_TYPE.test(item.mediaType)) {
        const preferred = MediaTypes.preferred(item.mediaType, item.href);
        if (preferred !== undefined) {
          findings.push(at(item.element, "OPF-090", preferred, item.mediaType));
        }
        if (!isRemote(item.href) && item.href.includes("#")) {
          findings.push(at(item.element, "OPF-091"));
        }
      }
    }
  }
  // Upstream checks properties as it reads each `item` that it registers (an `href`, and an `id`
  // without surrounding whitespace), duplicates included; a repeated property counts once.
  if (opf.version === "3") {
    for (const item of opf.items) {
      const id = Xml.attribute(item.element, "id");
      if (id === undefined || id !== JavaText.trim(id)) continue;
      if (Xml.attribute(item.element, "href") === undefined) continue;
      for (const property of new Set(item.properties)) {
        if (!allowedFor(property, item.mediaType))
          findings.push(at(item.element, "OPF-012", property, item.mediaType));
      }
    }
  }
  const fallbackOf = (item: ManifestItem) => (Xml.attribute(item.element, "fallback") ?? "").trim();
  for (const item of opf.items) {
    const fallback = fallbackOf(item);
    if (fallback !== "" && !byId.has(fallback))
      findings.push(at(item.element, "OPF-040", fallback));
    // Upstream quotes the item's `fallback`, not its `fallback-style`, in OPF-041.
    const style = Xml.attribute(item.element, "fallback-style");
    if (opf.version === "2" && style !== undefined && !byId.has(style.trim())) {
      findings.push(at(item.element, "OPF-041", Xml.attribute(item.element, "fallback") ?? "null"));
    }
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

const CONTENT_DOCUMENT_TYPES = new Set(["application/xhtml+xml", "image/svg+xml"]);

// An EPUB 3 spine item that is not a content document needs a fallback chain to one; upstream
// reports it at the manifest item.
const spineFallbackFinding = (
  item: ManifestItem,
  contentFallback: (item: ManifestItem) => boolean,
) => {
  if (Fallbacks.isBlessedItemType(item.mediaType, "3")) return [];
  if (item.fallback === undefined) return [at(item.element, "OPF-043", item.mediaType)];
  return contentFallback(item) ? [] : [at(item.element, "OPF-044", item.mediaType)];
};

// Upstream's RenditionVocabs.SPREAD_PROPERTIES.
const SPREADS = /^(?:rendition:page-spread-(?:left|right|center)|page-spread-(?:left|right))$/;

const spineChecks = ({ document, opf, urls }: Checks) => {
  const findings: Array<Finding> = [];
  // Upstream looks itemrefs up among the items it registers.
  const items = new Map([...registered(opf)].map((item) => [item.id, item] as const));
  const contentFallback = Fallbacks.resolveFallbacks(items, "3").content;
  const spine = opfChildren(document.root, "spine")[0];
  const itemrefs = opfChildren(spine, "itemref");
  const fixed = FixedLayout.fixedLayoutIds(opf);
  const merged = new Map<string, Set<string>>();
  for (const { idref, padded, properties } of opf.spineItems) {
    if (!padded) merged.set(idref, new Set([...(merged.get(idref) ?? []), ...properties]));
  }
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
    // Data URLs are reported elsewhere (RSC-029); remote items are checked too.
    if (opf.version === "3" && !/^data:/i.test(item.href)) {
      findings.push(...spineFallbackFinding(item, contentFallback));
      if (item.properties.includes("data-nav")) findings.push(at(item.element, "OPF-077"));
    }
    // Page spreads belong to pre-paginated content; upstream also reports them under `roll`, once
    // per spine entry, from the properties of all the item's itemrefs.
    if (opf.version === "3" && (!fixed.has(idref) || opf.metadata.layouts.includes("roll"))) {
      for (const property of merged.get(idref) ?? []) {
        if (SPREADS.test(property)) findings.push(at(item.element, "OPF-100", property));
      }
    }
    seen.add(idref);
  }
  if (linear.size > 0 && ![...linear.values()].includes(true)) findings.push(nowhere("OPF-033"));
  findings.push(...problemsOf(urls, "reference"));
  return findings;
};

// java.util.UUID.fromString: five dash-separated hexadecimal numbers that each fit a signed
// long, 36 characters at most.
const isJavaUuid = (value: string) => {
  const parts = value.split("-");
  return (
    value.length <= 36 &&
    parts.length === 5 &&
    parts.every((part) => JavaDigits.parse(part, 16, JavaDigits.MAX_LONG) !== undefined)
  );
};

const metadataChecks = ({ document, opf, container }: Context) => {
  const findings: Array<Finding> = [];
  const root = document.root;
  const dcElements = (local: string) =>
    metadataElements(root)
      .flatMap((element) => [...Xml.descendants(element)])
      .filter((element) => element.ns === DC_NS && element.local === local);

  const uniqueIdentifier = Xml.attribute(root, "unique-identifier");
  if (uniqueIdentifier === undefined || uniqueIdentifier === "") findings.push(at(root, "OPF-048"));
  // Upstream matches each identifier's trimmed `id` against the attribute as written.
  const uniques = dcElements("identifier").filter((element) => {
    const id = Xml.attribute(element, "id");
    return (
      id !== undefined && id !== "" && uniqueIdentifier !== "" && id.trim() === uniqueIdentifier
    );
  });
  const declared = dcElements("identifier").some((element) => {
    const id = Xml.attribute(element, "id");
    return id !== undefined && id !== "" && id === uniqueIdentifier;
  });
  if (!declared && container !== undefined) {
    findings.push(
      nowhere(
        "OPF-030",
        uniqueIdentifier === undefined || uniqueIdentifier === "" ? "null" : uniqueIdentifier,
      ),
    );
  }
  for (const identifier of uniques) {
    // Upstream skips an identifier without character data.
    if (!identifier.children.some((child) => child.kind === "text")) continue;
    const value = Xml.textContent(identifier).trim();
    const scheme = Xml.attribute(identifier, "scheme", OPF_NS)?.toLowerCase();
    if (
      (value.startsWith("urn:uuid:") || scheme === "uuid") &&
      !isJavaUuid(value.replaceAll("urn:uuid:", ""))
    ) {
      findings.push(atEnd(identifier, "OPF-085", value));
    }
  }

  // EPUB 2: an empty title or language is OPF-055, and any other empty Dublin Core element but
  // an identifier or a date OPF-072. Upstream reads only the element's own text, Java-trimmed.
  if (opf.version === "2") {
    for (const element of metadataElements(root).flatMap((parent) => [
      ...Xml.descendants(parent),
    ])) {
      if (element.ns !== DC_NS || element.local === "identifier" || element.local === "date") {
        continue;
      }
      const text = element.children.flatMap((child) => (child.kind === "text" ? [child.text] : []));
      if (JavaText.trim(text.join("")) !== "") continue;
      if (element.local === "title" || element.local === "language") {
        findings.push(atEnd(element, "OPF-055", element.local));
      } else findings.push(atEnd(element, "OPF-072", `dc:${element.local}`));
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
    const prefixes = Vocabularies.parsePrefixes(Xml.attribute(root, "prefix"));
    for (const element of metadataElements(root)) {
      if (hasRefinesCycle(element, prefixes)) findings.push(atEnd(element, "OPF-065"));
    }
    // Upstream's checkMediaOverlaysDuration: the first unrefined `media:duration` against the sum
    // of the refined ones, within a second; an unreadable value stops the check.
    const durations = opfChildren(opfChildren(root, "metadata")[0], "meta").filter(
      (meta) =>
        Vocabularies.canonicalNames(Xml.attribute(meta, "property"), "meta", prefixes, false)[0] ===
        "media:duration",
    );
    const primary = (meta: Xml.XmlElement) => (Xml.attribute(meta, "refines") ?? "#") === "#";
    const total = durations.find(primary);
    const totalMillis = total === undefined ? undefined : ClockValue.parse(Xml.textContent(total));
    const parts = durations
      .filter((meta) => !primary(meta))
      .map((meta) => ClockValue.parse(Xml.textContent(meta)));
    if (
      totalMillis !== undefined &&
      parts.every((millis) => millis !== undefined) &&
      Math.abs(totalMillis - parts.reduce((sum, millis) => sum + (millis ?? 0), 0)) > 1000
    ) {
      findings.push(nowhere("MED-016"));
    }
  }
  return findings;
};

// Upstream follows `refines` between `meta` elements only, with the attribute as written.
// A `meta` whose property does not parse is not registered, so it refines nothing.
const hasRefinesCycle = (metadata: Xml.XmlElement, prefixes: Vocabularies.Prefixes) => {
  const refines = new Map<string, string>();
  for (const element of opfChildren(metadata, "meta")) {
    if (Xml.attribute(element, "name") !== undefined) continue;
    const property = Xml.attribute(element, "property");
    if (Vocabularies.parseProperties(property, "meta", prefixes, false).properties.length === 0) {
      continue;
    }
    const id = Xml.attribute(element, "id") ?? "";
    // Upstream follows a `refines` without `#` as written.
    const written = Xml.attribute(element, "refines") ?? "";
    const target = written.startsWith("#") ? written.slice(1) : written;
    if (id !== "" && target !== "") refines.set(id, target);
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
const vocabularyChecks = ({ document, opf, urls, files }: Checks) => {
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
  const metadatas = metadataElements(root);
  for (const meta of metadatas.flatMap((metadata) => opfChildren(metadata, "meta"))) {
    if (Xml.attribute(meta, "name") !== undefined) {
      findings.push(at(meta, "OBS-001", "element", 'OPF 2 "meta"'));
      continue;
    }
    // Upstream checks a `meta` at its end tag, and its `scheme` with the same vocabularies.
    const properties = property(meta, "property", "meta", false, atEnd);
    property(meta, "scheme", "meta", false, atEnd);
    if (
      properties.some(
        (parsed) =>
          parsed.name === "spread" &&
          prefixes.vocabs.get(parsed.prefix)?.uri === Vocabularies.RESERVED.rendition?.uri,
      ) &&
      JavaText.trim(Xml.textContent(meta)) === "portrait"
    ) {
      findings.push(
        atEnd(meta, "OPF-086", "rendition:spread portrait", keyedSuggestion("OPF-086", "")),
      );
    }
  }
  // Upstream's link checks, in its order: a data URL or a link into the package document itself
  // stops there, and an unparsable URL skips to the language tag.
  const packageUrl = new URL(opf.path, CONTAINER);
  const packageKey = normalizedUrl(packageUrl.href, packageUrl);
  // Links in the package metadata, in collection metadata, and directly in collections.
  const collections = [...Xml.descendants(root)].filter(
    (element) => element.ns === OPF_NS && element.local === "collection",
  );
  const declared = new Set(declaredPaths(opf));
  const links = [
    ...opfChildren(opfChildren(root, "metadata")[0], "link").map((link) => ({
      link,
      place: "package",
    })),
    ...collections.flatMap((collection) =>
      opfChildren(opfChildren(collection, "metadata")[0], "link").map((link) => ({
        link,
        place: "collection metadata",
      })),
    ),
    ...collections.flatMap((collection) =>
      opfChildren(collection, "link").map((link) => ({ link, place: "collection" })),
    ),
  ];
  for (const { link, place } of links) {
    const href = Xml.attribute(link, "href");
    const url = href === undefined ? null : URL.parse(href, packageUrl);
    findings.push(...(urls.get(link) ?? []));
    if (href !== undefined) findings.push(...urlSchemeFindings(link, href, opf.version));
    if (url?.protocol === "data:") continue;
    if (
      href !== undefined &&
      url !== null &&
      url.hash.length > 1 &&
      normalizedUrl(href.split("#")[0] ?? "", packageUrl) === packageKey
    ) {
      findings.push(at(link, "OPF-098", href));
      continue;
    }
    if (url !== null) {
      // A local link to an undeclared resource must be in the container. Upstream looks the URL
      // up with its fragment, so a link with one is never found.
      const trimmed = (href ?? "").trim();
      const target =
        trimmed === "" || trimmed.startsWith("#") || isRemote(trimmed)
          ? undefined
          : resolve(trimmed.split("#")[0] ?? trimmed, opf.path)?.normalize("NFC");
      if (
        target !== undefined &&
        files !== undefined &&
        !declared.has(target) &&
        (trimmed.includes("#") || !files.has(target))
      ) {
        findings.push(at(link, "RSC-007w", Url.encodePath(target)));
      }
      const parsedRels = property(link, "rel", "link-rel", true);
      const rels = new Set(
        parsedRels.filter((parsed) => parsed.prefix === "").map((parsed) => parsed.name),
      );
      // Any other relation, prefixed ones included, conflicts with `alternate`.
      const relCount = new Set(parsedRels.map((parsed) => parsed.token)).size;
      if (rels.has("alternate") && relCount > 1) findings.push(at(link, "OPF-089"));
      const mediaType = Xml.attribute(link, "media-type");
      if (mediaType === undefined) {
        // `file:` URLs count as local, as in upstream's isSameOrigin. Only the package metadata
        // asks local links for a media type; links directly in a collection are always asked
        // for one when they are records or voicings.
        const local = url.origin === CONTAINER.origin || url.protocol === "file:";
        if (local && place === "package") findings.push(at(link, "OPF-093"));
        else if ((!local || place === "collection") && (rels.has("record") || rels.has("voicing")))
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
  // Upstream reads an itemref's properties only when its `idref`, as written, names an item.
  const ids = new Set(
    opf.items.flatMap((item) => (Xml.attribute(item.element, "id") === undefined ? [] : [item.id])),
  );
  for (const itemref of opfChildren(opfChildren(root, "spine")[0], "itemref")) {
    const idref = Xml.attribute(itemref, "idref");
    if (idref !== undefined && ids.has(idref)) property(itemref, "properties", "itemref", true);
  }
  const guide = opfChildren(root, "guide")[0];
  if (guide !== undefined) findings.push(at(guide, "OBS-001", "element", 'OPF 2 "guide"'));
  // Only the outermost collections are reported.
  for (const collection of opfChildren(root, "collection")) {
    findings.push(at(collection, "OBS-001", "element", '"collection"'));
  }
  // A role with a scheme is a URL, which must parse; upstream stops at the first that does not.
  for (const collection of Xml.descendants(root)) {
    if (!PACKAGE_NAMESPACES.has(collection.ns) || collection.local !== "collection") continue;
    const roles = (Xml.attribute(collection, "role") ?? "").split(/[ \t\n\v\f\r]+/);
    const invalid = roles.find(
      (role) =>
        /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(JavaText.stripWhitespace(role)) && !URL.canParse(role),
    );
    if (invalid !== undefined) findings.push(at(collection, "OPF-070", invalid));
  }
  return findings;
};

const SEARCH_KEY_MAP = "application/vnd.epub.search-key-map+xml";

// Upstream's checks of the collections defined by EPUB Dictionaries, Indexes and Previews: each
// resource of a top-level collection, with an index's nested index groups.
const collectionChecks = ({ opf }: Context) => {
  const findings: Array<Finding> = [];
  const byPath = new Map(
    opf.items.flatMap((item) => (item.path === undefined ? [] : [[item.path, item] as const])),
  );
  const resources = (collection: Collection) =>
    collection.links.map(({ href, path }) => ({
      // Messages quote the container URL, not the decoded path.
      name: path === undefined ? href : Url.encodePath(path),
      href,
      item: path === undefined ? undefined : byPath.get(path),
    }));
  const index = (collection: Collection) => {
    if (!collection.roles.includes("index") && !collection.roles.includes("index-group")) return;
    for (const { item } of resources(collection)) {
      if (item?.mediaType !== "application/xhtml+xml") findings.push(nowhere("OPF-071"));
    }
    for (const child of collection.collections) index(child);
  };
  for (const collection of opf.collections) {
    if (collection.roles.includes("dictionary")) {
      let maps = 0;
      for (const { name, item } of resources(collection)) {
        if (item === undefined) findings.push(nowhere("OPF-081", name));
        else if (item.mediaType === SEARCH_KEY_MAP) {
          if (maps > 0) findings.push(nowhere("OPF-082"));
          maps++;
        } else if (item.mediaType !== "application/xhtml+xml") {
          findings.push(nowhere("OPF-084", name));
        }
      }
      if (maps === 0) findings.push(nowhere("OPF-083"));
    }
    if (collection.roles.includes("index")) index(collection);
    if (collection.roles.includes("preview")) {
      for (const { href, item } of resources(collection)) {
        if (item === undefined || !CONTENT_DOCUMENT_TYPES.has(item.mediaType)) {
          findings.push(nowhere("OPF-075"));
          continue;
        }
        const hash = href.indexOf("#");
        const fragment = hash < 0 ? undefined : href.slice(hash + 1);
        if (fragment !== undefined && parseFragment(fragment, "").scheme === "epubcfi") {
          findings.push(nowhere("OPF-076"));
        }
      }
    }
  }
  return findings;
};

// Upstream's checkGuide, in both versions of a full check: a reference names a manifest item
// (OPF-031) of an OPS content document type (OPF-032), quoted with its fragment. A query the URL
// checker keeps (after an absolute URL, with no RSC-033) makes it name no item.
const GUIDE_TYPES = {
  "2": new Set(["application/xhtml+xml", "application/x-dtbook+xml"]),
  "3": new Set(["application/xhtml+xml", "image/svg+xml"]),
};
const LEGACY_GUIDE_TYPES = new Set(["text/x-oeb1-document", "text/html"]);

const guideChecks = ({ opf, container, urls }: Checks) => {
  const findings: Array<Finding> = [];
  if (container === undefined) return findings;
  // The package's URL checker knows whether the query is kept; this one only resolves.
  const resolver = Url.checker(opf.path, { container: true });
  const byUrl = new Map(
    [...registered(opf)].map((item) => [
      item.path === undefined ? Url.remoteKey(item.href) : item.path.normalize("NFC"),
      item,
    ]),
  );
  for (const reference of opf.guide) {
    const href = Xml.attribute(reference, "href");
    const resolved = href === undefined ? undefined : resolver.check(href).resolved;
    if (resolved === undefined) continue;
    const { target, fragment } = resolved;
    const stripped = (urls.get(reference) ?? []).some((problem) => problem.id === "RSC-033");
    const query =
      target.kind === "local" && !stripped ? (/\?[^#]*/.exec(href ?? "")?.[0] ?? "") : "";
    const name = Url.nameOf(target) + query + (fragment === undefined ? "" : `#${fragment}`);
    const key = target.kind === "local" ? target.path : target.kind === "remote" ? target.url : "";
    const item = query === "" ? byUrl.get(key) : undefined;
    if (item === undefined) findings.push(at(reference, "OPF-031", name));
    else if (
      !GUIDE_TYPES[opf.version].has(item.mediaType) &&
      !LEGACY_GUIDE_TYPES.has(item.mediaType)
    ) {
      findings.push(at(reference, "OPF-032", name));
    }
  }
  return findings;
};

// Rules upstream's package handler applies in both versions, in its order: an OEBPS 1.2
// package (OPF-047), MARC relator roles on creators (OPF-052), Adobe's `page-map` (OPF-062,
// OPF-063), and the spine's `toc`, which names an item (OPF-049) that is an NCX (OPF-050). The
// handler reads package elements only in the OPF and OEBPS 1.2 namespaces, or none.
const handlerChecks = ({ document, opf }: Context) => {
  const findings: Array<Finding> = [];
  const root = document.root;
  const read = root.ns === OPF_NS || root.ns === OEB_PACKAGE_NS || root.ns === "";
  const legacy = read && root.ns !== OPF_NS;
  if (legacy) findings.push(at(root, "OPF-047"));
  for (const element of Xml.descendants(root)) {
    // Outside an OEBPS 1.2 package, upstream reports these wrappers as unknown IDs, by name.
    const wrapper = element.local === "dc-metadata" || element.local === "x-metadata";
    if (!legacy && wrapper && PACKAGE_NAMESPACES.has(element.ns)) {
      findings.push(at(element, "OPF-049", element.local));
    }
    if (element.ns !== DC_NS || element.local !== "creator") continue;
    // Upstream compares the role as written, and accepts any `oth.` role.
    const role = Xml.attribute(element, "role", OPF_NS);
    if (role !== undefined && role !== "" && !MARC_RELATORS.has(role) && !role.startsWith("oth.")) {
      findings.push(at(element, "OPF-052", role));
    }
  }
  // Every spine counts; the last page map is looked up, by its ID as written, at the end.
  const byId = new Map([...registered(opf)].map((item) => [item.id, item] as const));
  const ncx = new Set<ManifestItem>();
  let pageMap: { readonly spine: Xml.XmlElement; readonly id: string } | undefined;
  for (const spine of Xml.childElements(root)) {
    if (!PACKAGE_NAMESPACES.has(spine.ns) || spine.local !== "spine") continue;
    const id = Xml.attribute(spine, "page-map");
    if (id !== undefined) {
      findings.push(at(spine, "OPF-062"));
      pageMap = { spine, id };
    }
    const toc = Xml.attribute(spine, "toc");
    const item = toc === undefined ? undefined : byId.get(toc.trim());
    if (toc !== undefined && item === undefined) findings.push(at(spine, "OPF-049", toc));
    if (item !== undefined) ncx.add(item);
  }
  for (const item of byId.values()) {
    if (ncx.has(item) && item.mediaType !== "application/x-dtbncx+xml") {
      findings.push(at(item.element, "OPF-050"));
    }
  }
  if (pageMap !== undefined && !byId.has(pageMap.id)) {
    findings.push(at(pageMap.spine, "OPF-063", pageMap.id));
  }
  return findings;
};

export const check = (context: Context) => {
  const checks = { ...context, ...shared(context) };
  return [
    ...(context.opf.version === "3" ? vocabularyChecks(checks) : []),
    ...metadataChecks(checks),
    ...handlerChecks(checks),
    ...manifestChecks(checks),
    ...spineChecks(checks),
    ...guideChecks(checks),
    ...(context.opf.version === "3" ? collectionChecks(checks) : []),
  ];
};
