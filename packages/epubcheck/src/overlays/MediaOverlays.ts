import type { MessageId } from "../messages/MessageCatalog.ts";
import type { ManifestItem, Metadata } from "../opf/PackageDocument.ts";
import type { Finding, Reference } from "../references/Collect.ts";
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

export interface PublicationContext {
  readonly items: ReadonlyMap<string, ManifestItem>;
  // IDs of each content document, in document order.
  readonly ids: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly spine: ReadonlyArray<string>;
  readonly packagePath: string;
  readonly narrators: ReadonlyMap<string, string>;
  // Every manifest item, remote ones included, in manifest order.
  readonly manifest: ReadonlyArray<ManifestItem>;
}

// The text link checks upstream's reference checker makes, and its reading order check over all
// the overlays' links; then the package's media-overlay attributes against the narrators.
export const publicationFindings = (
  overlays: ReadonlyArray<{ readonly path: string; readonly overlay: Overlay }>,
  context: PublicationContext,
) => {
  const findings: Array<Finding> = [];
  // ID positions count from 1; a link without a fragment is at 0, an unknown ID at -1.
  const anchorOf = (document: string, id: string) =>
    id === "" ? 0 : (context.ids.get(document)?.get(id) ?? -2) + 1;
  let lastSpine = -1;
  let lastAnchor = -1;
  for (const { path, overlay } of overlays) {
    for (const link of overlay.links) {
      const { target, fragment } = link.resolved;
      if (target.kind !== "local") continue;
      const item = context.items.get(target.path);
      if (item === undefined) continue;
      const parsed = UrlFragment.parse(fragment ?? "", item.mediaType);
      const name = Url.nameOf(target) + (fragment === undefined ? "" : `#${fragment}`);
      // References to other resources are reported elsewhere (RSC-010) and checked no further.
      if (isContentDocument(item.mediaType) && fragment !== undefined && fragment !== "") {
        if (item.mediaType === "application/xhtml+xml" && parsed.id === "") {
          findings.push(finding(path, link, "MED-017", fragment));
        } else if (item.mediaType === "image/svg+xml" && !parsed.isValid) {
          findings.push(finding(path, link, "MED-018", fragment));
        }
        if (parsed.id !== "" && context.ids.get(target.path)?.has(parsed.id) !== true) {
          findings.push(finding(path, link, "RSC-012"));
        }
      }
      const spine = context.spine.indexOf(target.path);
      if (spine < 0) continue;
      if (spine < lastSpine) {
        findings.push(finding(path, link, "MED-015", name, "spine"));
        lastSpine = spine;
        lastAnchor = -1;
        continue;
      }
      if (spine > lastSpine) {
        lastSpine = spine;
        lastAnchor = -1;
      }
      const anchor = anchorOf(target.path, parsed.id);
      if (anchor < 0) continue;
      if (anchor < lastAnchor) findings.push(finding(path, link, "MED-015", name, "document"));
      lastAnchor = anchor;
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
      findings.push(finding(context.packagePath, at, "MED-010"));
    } else if (narrator !== undefined && declared !== narrator) {
      findings.push(finding(context.packagePath, at, "MED-012"));
    } else if (narrator === undefined && declared !== undefined && declared !== "") {
      findings.push(finding(context.packagePath, at, "MED-013"));
    }
  }
  return findings;
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
