import type { MessageId } from "../messages/MessageCatalog.ts";
import * as Fallbacks from "../opf/Fallbacks.ts";
import type { ManifestItem } from "../opf/PackageDocument.ts";
import * as MediaTypes from "../resources/MediaTypes.ts";
import * as UrlFragment from "../util/UrlFragment.ts";
import type { Features, Finding, Reference, ReferenceType } from "./Collect.ts";
import * as Url from "./Url.ts";

// Checks the collected references once all documents are read, in upstream's order: a remote
// resource must be allowed, a target must be in the container and the manifest, a foreign
// resource needs a fallback, a reference must suit its target's type, and a fragment must name
// an existing ID. The first problem found for a reference is the only one reported.

export interface Publication {
  readonly version: "2" | "3";
  readonly packagePath: string;
  // Container paths, NFC-normalized like the targets of references.
  readonly files: ReadonlySet<string>;
  readonly items: ReadonlyMap<string, ManifestItem>;
  readonly byId: ReadonlyMap<string, ManifestItem>;
  // Remote manifest items, by `Url.remoteKey`.
  readonly remoteItems: ReadonlyMap<string, ManifestItem>;
  readonly spine: ReadonlySet<ManifestItem>;
  readonly ids: ReadonlyMap<string, ReadonlySet<string>>;
  // Documents that failed to parse: upstream knows the IDs before the error, we know none.
  readonly unparsed: ReadonlySet<string>;
}

// Remote audio, video and fonts are allowed in EPUB 3, by reference type or declared type.
const REMOTE_TYPES = new Set<ReferenceType>(["audio", "video", "font"]);
const isRemoteMediaType = (mediaType: string) =>
  /^(?:audio|video|font)\/|^application\/font-/.test(mediaType) ||
  mediaType === "application/vnd.ms-opentype";
// Hyperlinks and citations are not publication resources.
const NAVIGATION = new Set<ReferenceType>(["hyperlink", "cite"]);

// What a hyperlink may point to, without a fallback; other types are non-standard (RSC-010).
const isLinkable = (mediaType: string, version: "2" | "3") =>
  Fallbacks.isBlessedItemType(mediaType, version) ||
  Fallbacks.isDeprecatedBlessedItemType(mediaType);

const PACKAGE_TYPE = "application/oebps-package+xml";

const essence = (mediaType: string) => (mediaType.split(";")[0] ?? "").trim().toLowerCase();
const isContent = (mediaType: string) =>
  essence(mediaType) === "application/xhtml+xml" || essence(mediaType) === "image/svg+xml";

const finding = (reference: Reference, id: MessageId, ...args: ReadonlyArray<string>) => ({
  id,
  args,
  path: reference.path,
  line: reference.line,
  column: reference.column,
});

const itemOf = (reference: Reference, publication: Publication) => {
  const { target } = reference;
  if (target.kind === "local") return publication.items.get(target.path);
  if (target.kind === "remote") return publication.remoteItems.get(target.url);
  return undefined;
};

// The types upstream requires a core media type or a fallback for (RSC-032).
const NEEDS_FALLBACK = new Set<ReferenceType>([
  "image",
  "audio",
  "generic",
  "iframe",
  "object",
  "embed",
]);

// Whether a document loads an SVG image, which allows its `svg` property.
export const loadsSvg = (references: ReadonlyArray<Reference>, publication: Publication) =>
  references.some((reference) => {
    const item = reference.resource ? itemOf(reference, publication) : undefined;
    return item !== undefined && essence(item.mediaType) === "image/svg+xml";
  });

export const check = (references: ReadonlyArray<Reference>, publication: Publication) => {
  const findings: Array<Finding> = [];
  const epub3 = publication.version === "3";
  // Whether an item's manifest fallback chain reaches a resource of some type.
  const hasFallback = (item: ManifestItem | undefined, accepts: (mediaType: string) => boolean) => {
    const seen = new Set<string>();
    let current = item;
    while (current?.fallback !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      current = publication.byId.get(current.fallback);
      if (current !== undefined && accepts(current.mediaType)) return true;
    }
    return false;
  };
  const hasCoreFallback = (item: ManifestItem | undefined) => hasFallback(item, MediaTypes.isCore);
  const contentFallback = Fallbacks.contentDocumentFallback(publication.byId, publication.version);
  // A foreign resource needs a fallback (RSC-032), and a script must be JavaScript.
  const resourceFindings = (reference: Reference, mediaType: string, item?: ManifestItem) => {
    const name = Url.nameOf(reference.target);
    if (
      NEEDS_FALLBACK.has(reference.type) &&
      reference.intrinsicFallback !== true &&
      !MediaTypes.isCore(mediaType) &&
      !hasCoreFallback(item)
    ) {
      findings.push(finding(reference, "RSC-032", name, mediaType));
    }
    if (reference.type !== "script") return true;
    if (!MediaTypes.isJavaScript(mediaType)) {
      findings.push(finding(reference, "RSC-034"));
      return false;
    }
    if (MediaTypes.isLegacyJavaScript(mediaType)) {
      findings.push(finding(reference, "RSC-035", mediaType));
    }
    return true;
  };
  // Undeclared resources are reported once each.
  const undeclared = new Set<string>();
  for (const reference of references) {
    const { target, type } = reference;
    // Data URLs are resources of their own, registered with their type normalized, never in the
    // spine. The package document is a resource too, of a type no reference may point to (checked
    // later).
    if (target.kind === "data") {
      const mediaType = MediaTypes.normalize(target.mediaType);
      if (type === "hyperlink") {
        const linkable = isLinkable(mediaType, publication.version);
        findings.push(finding(reference, linkable ? "RSC-011" : "RSC-010"));
      } else resourceFindings(reference, mediaType);
      continue;
    }
    // Upstream registers the package document as a resource, which is no content document.
    if (target.kind === "local" && target.path === publication.packagePath) {
      const cfi = UrlFragment.parse(reference.fragment ?? "", PACKAGE_TYPE).scheme === "epubcfi";
      if (type === "hyperlink" && !cfi) findings.push(finding(reference, "RSC-010"));
      else if (type !== "hyperlink") resourceFindings(reference, PACKAGE_TYPE);
      continue;
    }
    const item = itemOf(reference, publication);
    if (target.kind === "remote") {
      const url = target.url + (reference.fragment === undefined ? "" : `#${reference.fragment}`);
      const allowed =
        epub3 &&
        ((item !== undefined &&
          (publication.spine.has(item) || isRemoteMediaType(item.mediaType))) ||
          REMOTE_TYPES.has(type));
      if (!NAVIGATION.has(type) && !allowed) {
        findings.push(finding(reference, "RSC-006", url));
        continue;
      }
      if (epub3 && type !== "hyperlink" && target.scheme !== "https" && target.scheme !== "file") {
        findings.push(finding(reference, "RSC-031", url));
      }
    }
    if (item === undefined) {
      const name = Url.nameOf(target);
      // Upstream looks the URL up with its fragment, so an undeclared file referenced with a
      // fragment is reported as missing.
      if (
        target.kind === "local" &&
        (reference.fragment !== undefined || !publication.files.has(target.path))
      ) {
        findings.push(finding(reference, "RSC-007", name));
      } else if (!undeclared.has(name) && !(target.kind === "remote" && NAVIGATION.has(type))) {
        undeclared.add(name);
        findings.push(finding(reference, "RSC-008", name));
      }
      continue;
    }
    // An overlay link's fragment is checked with the other overlay rules.
    if (type === "overlay-text") continue;
    if (!resourceFindings(reference, item.mediaType, item)) continue;
    const fragment = reference.fragment;
    const parsed = UrlFragment.parse(fragment ?? "", item.mediaType);
    // Only SVG images can have fragments (other than EPUB CFIs), and style sheets none.
    if (
      type === "image" &&
      fragment !== undefined &&
      parsed.scheme !== "epubcfi" &&
      essence(item.mediaType) !== "image/svg+xml"
    ) {
      findings.push(finding(reference, "RSC-009"));
      continue;
    }
    if (type === "stylesheet" && fragment !== undefined) {
      findings.push(finding(reference, "RSC-013"));
      continue;
    }
    // A search key must lead to a spine item, unless an EPUB CFI says where.
    if (type === "search-key" && !publication.spine.has(item) && parsed.scheme !== "epubcfi") {
      findings.push(finding(reference, "RSC-021", Url.nameOf(target)));
      continue;
    }
    // Upstream does not check where EPUB CFIs lead.
    if (type === "hyperlink" && parsed.scheme !== "epubcfi") {
      if (!isLinkable(item.mediaType, publication.version) && !contentFallback(item)) {
        findings.push(finding(reference, "RSC-010"));
        continue;
      }
      if (!publication.spine.has(item)) {
        findings.push(finding(reference, "RSC-011"));
        continue;
      }
    }
    if (fragment === undefined || fragment === "" || target.kind === "remote") continue;
    if (publication.unparsed.has(target.path)) continue;
    if (
      parsed.id !== "" &&
      isContent(item.mediaType) &&
      publication.ids.get(target.path)?.has(parsed.id) !== true
    ) {
      findings.push(finding(reference, "RSC-012"));
    }
  }
  return findings;
};

// The item vocabulary, in upstream's order.
const ITEM_PROPERTIES = [
  "cover-image",
  "data-nav",
  "dictionary",
  "glossary",
  "index",
  "mathml",
  "nav",
  "remote-resources",
  "scripted",
  "search-key-map",
  "svg",
  "switch",
];

// Manifest properties that describe an EPUB 3 content document: OPF-014 when the content needs
// one, OPF-018 or OPF-015 when it is declared without such content.
export const propertyFindings = (
  item: ManifestItem,
  path: string,
  features: Features,
  end: { readonly line: number; readonly column: number },
  svgAllowed: boolean,
) => {
  const findings: Array<Finding> = [];
  const at = (id: MessageId, args: ReadonlyArray<string>, line = -1, column = -1) =>
    findings.push({ id, args, path, line, column });
  const declared = ITEM_PROPERTIES.filter((property) => item.properties.includes(property));
  // The CSS of `style` elements and attributes checks its own remote resources.
  if (!declared.includes("remote-resources")) {
    for (const line of features.remoteStyles) at("OPF-014", ["remote-resources"], line, 0);
  }
  const required = new Set<string>();
  if (features.mathml) required.add("mathml");
  if (features.remoteResources) required.add("remote-resources");
  if (features.scripted) required.add("scripted");
  if (features.svg) required.add("svg");
  if (features.switch) required.add("switch");
  for (const property of ITEM_PROPERTIES) {
    if (required.has(property) && !declared.includes(property)) at("OPF-014", [property]);
  }
  const allowed = new Set(["nav", "data-nav", "cover-image", ...required]);
  if (svgAllowed) allowed.add("svg");
  if (features.index) allowed.add("index");
  if (features.glossary) allowed.add("glossary");
  const unchecked = declared.filter((property) => !allowed.has(property));
  if (unchecked.includes("remote-resources")) {
    at(features.scripted ? "OPF-018b" : "OPF-018", [], end.line, end.column);
  }
  const others = unchecked.filter((property) => property !== "remote-resources");
  if (others.length > 0) at("OPF-015", [others.join(", ")]);
  return findings;
};

// A style sheet's `remote-resources` property: it must match the remote resources it uses.
export const styleSheetFindings = (item: ManifestItem, path: string, usesRemote: boolean) => {
  const declared = item.properties.includes("remote-resources");
  const at = (id: MessageId, args: ReadonlyArray<string>) => ({
    id,
    args,
    path,
    line: 0,
    column: 0,
  });
  if (usesRemote && !declared) return [at("OPF-014", ["remote-resources"])];
  if (!usesRemote && declared) return [at("OPF-018", [])];
  return [];
};
