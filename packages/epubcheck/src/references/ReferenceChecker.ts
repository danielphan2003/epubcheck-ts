import type { MessageId } from "../messages/MessageCatalog.ts";
import type { ManifestItem } from "../opf/PackageDocument.ts";
import * as UrlFragment from "../util/UrlFragment.ts";
import type { Features, Finding, Reference, ReferenceType } from "./Collect.ts";
import * as Url from "./Url.ts";

// Checks the collected references once all documents are read, in upstream's order: a remote
// resource must be allowed, a target must be in the container and the manifest, a hyperlink
// must reach a spine item, and a fragment must name an existing ID. The first problem found
// for a reference is the only one reported.

export interface Publication {
  readonly version: "2" | "3";
  readonly packagePath: string;
  // Container paths, NFC-normalized like the targets of references.
  readonly files: ReadonlySet<string>;
  readonly items: ReadonlyMap<string, ManifestItem>;
  // Remote manifest items, by `Url.remoteKey`.
  readonly remoteItems: ReadonlyMap<string, ManifestItem>;
  readonly spine: ReadonlySet<ManifestItem>;
  readonly ids: ReadonlyMap<string, ReadonlySet<string>>;
}

// Remote audio, video and fonts are allowed in EPUB 3, by reference type or declared type.
const REMOTE_TYPES = new Set<ReferenceType>(["audio", "video", "font"]);
const isRemoteMediaType = (mediaType: string) =>
  /^(?:audio|video|font)\/|^application\/font-/.test(mediaType) ||
  mediaType === "application/vnd.ms-opentype";
// Hyperlinks and citations are not publication resources.
const NAVIGATION = new Set<ReferenceType>(["hyperlink", "cite"]);

// What a hyperlink may point to; links to other types are reported as such by a later check.
const isLinkable = (mediaType: string, version: "2" | "3") =>
  mediaType === "application/xhtml+xml" ||
  mediaType === (version === "3" ? "image/svg+xml" : "application/x-dtbook+xml") ||
  mediaType === "text/x-oeb1-document" ||
  mediaType === "text/html";

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

// Whether a document loads an SVG image, which allows its `svg` property.
export const loadsSvg = (references: ReadonlyArray<Reference>, publication: Publication) =>
  references.some((reference) => {
    const item = reference.resource ? itemOf(reference, publication) : undefined;
    return item !== undefined && essence(item.mediaType) === "image/svg+xml";
  });

export const check = (references: ReadonlyArray<Reference>, publication: Publication) => {
  const findings: Array<Finding> = [];
  const epub3 = publication.version === "3";
  // Undeclared resources are reported once each.
  const undeclared = new Set<string>();
  for (const reference of references) {
    const { target, type } = reference;
    // Data URLs are resources of their own, never in the spine. The package document is a
    // resource too, of a type no reference may point to (checked later).
    if (target.kind === "data") {
      if (type === "hyperlink" && isLinkable(target.mediaType, publication.version)) {
        findings.push(finding(reference, "RSC-011"));
      }
      continue;
    }
    if (target.kind === "local" && target.path === publication.packagePath) continue;
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
      const name = target.kind === "remote" ? target.url : Url.encodePath(target.path);
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
    if (type === "hyperlink" && !isLinkable(item.mediaType, publication.version)) continue;
    if (type === "hyperlink" && !publication.spine.has(item)) {
      findings.push(finding(reference, "RSC-011"));
      continue;
    }
    const fragment = reference.fragment;
    if (fragment === undefined || fragment === "" || target.kind === "remote") continue;
    // Style sheets and non-SVG images must not have fragments at all; that is checked later.
    if (type === "stylesheet" || (type === "image" && essence(item.mediaType) !== "image/svg+xml"))
      continue;
    const parsed = UrlFragment.parse(fragment, item.mediaType);
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
