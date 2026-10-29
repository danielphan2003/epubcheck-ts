import { keyedSuggestion, type MessageId } from "../messages/MessageCatalog.ts";
import * as JavaText from "../util/JavaText.ts";
import { percentDecode } from "../util/UrlFragment.ts";
import * as Xml from "../xml/Xml.ts";
import { checkLanguageTag } from "./LanguageTag.ts";
import type { ManifestItem, PackageDocument } from "./PackageDocument.ts";
import * as JavaDigits from "./JavaDigits.ts";
import * as Vocabularies from "./Vocabularies.ts";
import * as W3cDate from "./W3cDate.ts";

// Package document rules that the schemas do not express: manifest and spine integrity,
// fallback chains, identifiers, dates, language tags and links.

const OPF_NS = "http://www.idpf.org/2007/opf";
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

// Upstream normalizes an item's media type like MIMEType.normalize (essence trimmed and in lower
// case, parameters without a value dropped, a value quoted unless it is a token) and then tests
// a pattern in which `+-^` is a range, so a quoted value fails it.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const ITEM_MEDIA_TYPE = /^[a-zA-Z0-9!#$&+-^_]+\/[a-zA-Z0-9!#$&+-^_]+$/;
const normalizedMediaType = (value: string) => {
  const [essence = "", ...parameters] = value.split(";");
  const type = new RegExp(`^\\s*(${TOKEN}/${TOKEN})\\s*$`).exec(essence)?.[1];
  if (type === undefined) return undefined;
  const kept = parameters.flatMap((parameter) => {
    const separator = parameter.indexOf("=");
    const name = parameter.slice(0, separator).trim();
    const raw = parameter.slice(separator + 1).trim();
    if (separator < 0 || !new RegExp(`^${TOKEN}$`).test(name) || raw === "") return [];
    const quoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"');
    const text = quoted ? raw.slice(1, -1) : raw;
    const written = text !== "" && new RegExp(`^${TOKEN}$`).test(text) ? text : `"${text}"`;
    return [`${name.toLowerCase()}=${written}`];
  });
  return [type.toLowerCase(), ...kept].join(";");
};
const isCheckedMediaType = (mediaType: string) => {
  const normalized = normalizedMediaType(mediaType);
  return normalized !== undefined && ITEM_MEDIA_TYPE.test(normalized);
};

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

// The package metadata, then that of each collection, which upstream checks the same way.
const metadataElements = (root: Xml.XmlElement) => [
  ...opfChildren(root, "metadata").slice(0, 1),
  ...[...Xml.descendants(root)]
    .filter((element) => element.ns === OPF_NS && element.local === "collection")
    .flatMap((collection) => opfChildren(collection, "metadata").slice(0, 1)),
];

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
  // Upstream identifies items by normalized URL, fragment included. The last item for a URL is
  // the one it keeps and checks; every other one is a duplicate. An item without one is skipped.
  const packageUrl = new URL(opf.path, CONTAINER);
  const packageKey = normalizedUrl(packageUrl.href, packageUrl);
  const urlOf = (item: ManifestItem) =>
    Xml.attribute(item.element, "href") === undefined
      ? undefined
      : normalizedUrl(item.href, packageUrl);
  // Upstream holds items by ID first: a repeated ID keeps its first position with the last item.
  const items = [...byId.values()];
  const kept = new Map(items.map((item) => [urlOf(item), item] as const));
  for (const item of items) {
    const url = urlOf(item);
    if (url === undefined) continue;
    // Upstream looks every item up in the container, duplicates included.
    if (
      files !== undefined &&
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
    if (opf.version === "3") {
      const checked =
        !isRemote(item.href) &&
        !item.href.startsWith("data:") &&
        isCheckedMediaType(item.mediaType);
      if (checked && item.href.includes("#")) findings.push(at(item.element, "OPF-091"));
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
  for (const itemref of opfChildren(opfChildren(root, "spine")[0], "itemref")) {
    property(itemref, "properties", "itemref", true);
  }
  const guide = opfChildren(root, "guide")[0];
  if (guide !== undefined) findings.push(at(guide, "OBS-001", "element", 'OPF 2 "guide"'));
  // Only the outermost collections are reported.
  for (const collection of opfChildren(root, "collection")) {
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
