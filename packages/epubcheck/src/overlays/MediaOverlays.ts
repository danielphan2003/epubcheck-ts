import type { MessageId } from "../messages/MessageCatalog.ts";
import type { ManifestItem, Metadata } from "../opf/PackageDocument.ts";
import type { Finding, IdType, Reference } from "../references/Collect.ts";
import * as ReadingOrder from "../references/ReadingOrder.ts";
import * as Url from "../references/Url.ts";
import * as ClockValue from "../util/ClockValue.ts";
import * as UrlFragment from "../util/UrlFragment.ts";
import * as Xml from "../xml/Xml.ts";

// Media Overlays rules beyond the schemas, after upstream's OverlayHandler and the overlay parts
// of its reference and package checks: audio clips, text links and their reading order, and the
// links between overlays and the content documents they narrate.

const SMIL_NS = "http://www.w3.org/ns/SMIL";
const OPS_NS = "http://www.idpf.org/2007/ops";

export interface Clip {
  readonly src: string;
  readonly line: number;
  readonly column: number;
}

// A text link: a `text` element's `src`, or the `epub:textref` of `body` or `seq`.
export interface Link {
  readonly resolved: Url.Resolved;
  readonly line: number;
  readonly column: number;
}

export interface Overlay {
  readonly audios: ReadonlyArray<Clip>;
  readonly links: ReadonlyArray<Link>;
}

// What reading an overlay needs from its publication; absent when an overlay is checked alone.
export interface Publication {
  readonly id: string;
  readonly mediaTypeOf: (target: Url.Target) => string | undefined;
  // Which overlay narrates each content document, filled as overlays are read.
  readonly narrators: Map<string, string>;
}

const finding = (
  path: string,
  at: { readonly line: number; readonly column: number },
  id: MessageId,
  ...args: ReadonlyArray<string>
): Finding => ({ id, args, path, line: at.line, column: at.column });

// Upstream's OPFChecker30.isBlessedAudioType.
const BLESSED_AUDIO = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/mp4;codecs=aac",
  "audio/mp4;codecs=opus",
  "audio/ogg;codecs=opus",
]);

const documentOf = (target: Url.Target) => (target.kind === "local" ? target.path : target.url);

// Reads an overlay's clips and links, and reports what upstream's OverlayHandler reports.
export const read = (document: Xml.XmlDocument, path: string, publication?: Publication) => {
  const audios: Array<Clip> = [];
  const links: Array<Link> = [];
  const findings: Array<Finding> = [];
  // In a publication, the links and clips are references too (RSC-006, RSC-007, ...).
  const references: Array<Reference> = [];
  const urls = Url.checker(path, { container: publication !== undefined });
  const check = (element: Xml.XmlElement, value: string | undefined) => {
    if (value === undefined) return undefined;
    const { problems, resolved } = urls.check(value);
    for (const problem of problems) {
      findings.push({ ...problem, path, line: element.line, column: element.column });
    }
    return resolved;
  };
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    if (element.ns !== SMIL_NS) continue;
    const local = element.local;
    if (local === "body" || local === "seq" || local === "text") {
      const value =
        local === "text"
          ? Xml.attribute(element, "src")
          : Xml.attribute(element, "textref", OPS_NS);
      const resolved = check(element, value);
      if (resolved === undefined || publication === undefined) continue;
      links.push({ resolved, line: element.line, column: element.column });
      references.push({
        ...resolved,
        type: "overlay-text",
        resource: false,
        path,
        line: element.line,
        column: element.column,
      });
      const narrated = documentOf(resolved.target);
      const narrator = publication.narrators.get(narrated);
      if (narrator === undefined) publication.narrators.set(narrated, publication.id);
      else if (narrator !== publication.id) findings.push(finding(path, element, "MED-011"));
      continue;
    }
    if (local !== "audio") continue;
    const src = Xml.attribute(element, "src");
    const resolved = check(element, src);
    if (src !== undefined)
      audios.push({ src: src.trim(), line: element.line, column: element.column });
    if (resolved?.fragment !== undefined) {
      findings.push(finding(path, element, "MED-014", resolved.fragment));
    }
    if (resolved !== undefined && publication !== undefined) {
      // Upstream registers the clip without its fragment, with no fallback needed.
      references.push({
        target: resolved.target,
        fragment: undefined,
        type: "audio",
        intrinsicFallback: true,
        resource: false,
        path,
        line: element.line,
        column: element.column,
      });
    }
    // Upstream finds no registered type for a data URL here.
    const type =
      resolved === undefined || resolved.target.kind === "data"
        ? undefined
        : publication?.mediaTypeOf(resolved.target);
    if (resolved !== undefined && type !== undefined && !BLESSED_AUDIO.has(type)) {
      findings.push(finding(path, element, "MED-005", Url.nameOf(resolved.target), type));
    }
    // A missing begin is 0; a clip without an end, or with an unreadable time, is not compared.
    const end = Xml.attribute(element, "clipEnd");
    const begin = ClockValue.parse(Xml.attribute(element, "clipBegin") ?? "0");
    const until = end === undefined ? undefined : ClockValue.parse(end);
    if (begin === undefined || until === undefined) continue;
    if (begin > until) findings.push(finding(path, element, "MED-008"));
    else if (begin === until) findings.push(finding(path, element, "MED-009"));
  }
  return { overlay: { audios, links } satisfies Overlay, findings, references };
};

const isContentDocument = (mediaType: string | undefined) =>
  mediaType === "application/xhtml+xml" || mediaType === "image/svg+xml";

export interface PublicationContext extends ReadingOrder.Context {
  readonly packagePath: string;
  readonly narrators: ReadonlyMap<string, string>;
  // The type of each ID in each content document, by the element that has it.
  readonly idTypes: ReadonlyMap<string, ReadonlyMap<string, IdType>>;
  // Every manifest item, remote ones included, in manifest order.
  readonly manifest: ReadonlyArray<ManifestItem>;
}

// The text link checks upstream's reference checker makes, its reading order check over all the
// overlays' links, which it reports after the `toc`'s, and the package's media-overlay
// attributes against the narrators.
export const publicationFindings = (
  overlays: ReadonlyArray<{ readonly path: string; readonly overlay: Overlay }>,
  context: PublicationContext,
) => {
  const links: Array<Finding> = [];
  const order: Array<Finding> = [];
  const narrators: Array<Finding> = [];
  const next = ReadingOrder.sequence(context);
  for (const { path, overlay } of overlays) {
    for (const link of overlay.links) {
      const { target, fragment } = link.resolved;
      if (target.kind !== "local") continue;
      const item = context.items.get(target.path);
      if (item === undefined) continue;
      const parsed = UrlFragment.parse(fragment ?? "", item.mediaType);
      // References to other resources are reported elsewhere (RSC-010) and checked no further.
      if (isContentDocument(item.mediaType) && fragment !== undefined && fragment !== "") {
        if (item.mediaType === "application/xhtml+xml" && parsed.id === "") {
          links.push(finding(path, link, "MED-017", Url.normalizeFragment(fragment)));
        } else if (item.mediaType === "image/svg+xml" && !parsed.isValid) {
          links.push(finding(path, link, "MED-018", Url.normalizeFragment(fragment)));
        }
        // A text link may name any element but an SVG paint server, clip path or symbol.
        if (parsed.id !== "") {
          const idType = context.idTypes.get(target.path)?.get(parsed.id);
          if (idType === undefined) links.push(finding(path, link, "RSC-012"));
          else if (idType !== "generic") links.push(finding(path, link, "RSC-014"));
        }
      }
      const broken = next(link.resolved);
      if (broken !== undefined) {
        const name = Url.referenceName(link.resolved);
        order.push(
          finding(path, link, "MED-015", name, ReadingOrder.orderName(broken, context.locale)),
        );
      }
    }
  }
  // Upstream checks each content document's media-overlay attribute against its narrator.
  for (const item of context.manifest) {
    if (!isContentDocument(item.mediaType)) continue;
    const declared = Xml.attribute(item.element, "media-overlay");
    const narrator = context.narrators.get(
      item.path === undefined ? Url.remoteKey(item.href) : item.path.normalize("NFC"),
    );
    const at = { line: item.element.line, column: item.element.column };
    if (narrator !== undefined && (declared === undefined || declared === "")) {
      narrators.push(finding(context.packagePath, at, "MED-010"));
    } else if (narrator !== undefined && declared !== narrator) {
      narrators.push(finding(context.packagePath, at, "MED-012"));
    } else if (narrator === undefined && declared !== undefined && declared !== "") {
      narrators.push(finding(context.packagePath, at, "MED-013"));
    }
  }
  return { links, order, narrators };
};

// Narrated documents need CSS for the declared styling classes (CSS-030).
export const styleFindings = (
  metadata: Metadata,
  documents: ReadonlyArray<{
    readonly item: ManifestItem;
    readonly path: string;
    readonly features: { readonly styled: boolean };
    readonly end: { readonly line: number; readonly column: number };
  }>,
) => {
  if (metadata.activeClass === undefined && metadata.playbackActiveClass === undefined) return [];
  return documents.flatMap((document) =>
    Xml.attribute(document.item.element, "media-overlay") !== undefined && !document.features.styled
      ? [finding(document.path, document.end, "CSS-030")]
      : [],
  );
};

// The well-known styling classes a style sheet may use without declaring them (CSS-029).
export const undeclaredClasses = (metadata: {
  readonly activeClass?: string | undefined;
  readonly playbackActiveClass?: string | undefined;
}) => [
  ...(metadata.activeClass === undefined
    ? [["-epub-media-overlay-active", "media:active-class"] as const]
    : []),
  ...(metadata.playbackActiveClass === undefined
    ? [["-epub-media-overlay-playing", "media:playback-active-class"] as const]
    : []),
];
