import type { MessageId } from "../messages/MessageCatalog.ts";
import type { ManifestItem, Metadata } from "../opf/PackageDocument.ts";
import type { Finding } from "../references/Collect.ts";
import * as MediaTypes from "../resources/MediaTypes.ts";
import * as ClockValue from "../util/ClockValue.ts";
import * as UrlFragment from "../util/UrlFragment.ts";
import * as Xml from "../xml/Xml.ts";

// Media Overlays rules beyond the schemas: audio clips, text references and their reading order,
// and the links between overlays and the content documents they narrate.

const SMIL_NS = "http://www.w3.org/ns/SMIL";
const OPS_NS = "http://www.idpf.org/2007/ops";

export interface Clip {
  readonly src: string;
  readonly line: number;
  readonly column: number;
}

export interface Overlay {
  readonly texts: ReadonlyArray<Clip>;
  readonly audios: ReadonlyArray<Clip>;
  // `epub:textref` attributes of `body`, `seq` and `par`.
  readonly textrefs: ReadonlyArray<Clip>;
}

const finding = (
  path: string,
  at: { readonly line: number; readonly column: number },
  id: MessageId,
  ...args: ReadonlyArray<string>
): Finding => ({ id, args, path, line: at.line, column: at.column });

// Milliseconds, so that equal clock values written differently compare equal.
const millis = (value: string | undefined) => {
  const seconds = value === undefined ? undefined : ClockValue.parse(value);
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
};

// Reads an overlay's clips, and reports the rules a single document can break.
export const read = (document: Xml.XmlDocument, path: string) => {
  const texts: Array<Clip> = [];
  const audios: Array<Clip> = [];
  const textrefs: Array<Clip> = [];
  const findings: Array<Finding> = [];
  for (const element of Xml.descendants(document.root)) {
    if (element.ns !== SMIL_NS) continue;
    const textref = Xml.attribute(element, "textref", OPS_NS)?.trim();
    if (textref !== undefined) {
      textrefs.push({ src: textref, line: element.line, column: element.column });
    }
    const src = Xml.attribute(element, "src")?.trim();
    if (src === undefined) continue;
    const clip = { src, line: element.line, column: element.column };
    if (element.local === "text") texts.push(clip);
    if (element.local !== "audio") continue;
    audios.push(clip);
    const hash = src.indexOf("#");
    if (hash >= 0) findings.push(finding(path, element, "MED-014", src.slice(hash + 1)));
    const begin = millis(Xml.attribute(element, "clipBegin")) ?? 0;
    const end = millis(Xml.attribute(element, "clipEnd"));
    if (end !== undefined && begin > end) findings.push(finding(path, element, "MED-008"));
    else if (end !== undefined && begin === end) findings.push(finding(path, element, "MED-009"));
  }
  return { overlay: { texts, audios, textrefs } satisfies Overlay, findings };
};

const resolve = (url: string, from: string) => {
  const segments = from.split("/").slice(0, -1);
  for (const segment of url.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "." && segment !== "") segments.push(segment);
  }
  try {
    return decodeURIComponent(segments.join("/"));
  } catch {
    return segments.join("/");
  }
};

export interface PublicationContext {
  readonly items: ReadonlyMap<string, ManifestItem>;
  // IDs of each content document, in document order.
  readonly ids: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly spine: ReadonlyArray<string>;
  readonly packagePath: string;
}

export const publicationFindings = (
  overlays: ReadonlyArray<{
    readonly item: ManifestItem;
    readonly path: string;
    readonly overlay: Overlay;
  }>,
  context: PublicationContext,
) => {
  const findings: Array<Finding> = [];
  const narratedBy = new Map<string, string>();
  for (const { item, path, overlay } of overlays) {
    for (const audio of overlay.audios) {
      const target = context.items.get(resolve(audio.src.split("#")[0] ?? audio.src, path));
      if (target?.path !== undefined && !MediaTypes.isCore(target.mediaType)) {
        findings.push(finding(path, audio, "MED-005", target.path, target.mediaType));
      }
    }
    // Resolves a text reference and checks its fragment; the position is the target's DOM order.
    const target = (clip: Clip) => {
      const hash = clip.src.indexOf("#");
      const document = resolve(hash < 0 ? clip.src : clip.src.slice(0, hash), path);
      const fragment = hash < 0 ? "" : clip.src.slice(hash + 1);
      const resource = context.items.get(document);
      if (resource === undefined) return undefined;
      const resolved: {
        readonly document: string;
        readonly fragment: string;
        readonly position: number | undefined;
      } = { document, fragment, position: undefined };
      if (fragment === "") return resolved;
      const isSvg = resource.mediaType === "image/svg+xml";
      const parsed = UrlFragment.parse(fragment, resource.mediaType);
      if (isSvg && !parsed.isValid) findings.push(finding(path, clip, "MED-018", fragment));
      else if (!isSvg && parsed.scheme !== "") {
        findings.push(finding(path, clip, "MED-017", fragment));
      } else if (parsed.id !== "") {
        const position = context.ids.get(document)?.get(parsed.id);
        if (position === undefined) findings.push(finding(path, clip, "RSC-012"));
        return { ...resolved, position };
      }
      return resolved;
    };
    for (const textref of overlay.textrefs) target(textref);
    const documents = new Set<string>();
    const spinePosition = (candidate: string) => context.spine.indexOf(candidate);
    let previous: { readonly document: string; readonly position: number } | undefined;
    for (const text of overlay.texts) {
      const resolved = target(text);
      if (resolved === undefined) continue;
      const { document, fragment, position } = resolved;
      if (!documents.has(document)) {
        documents.add(document);
        const other = narratedBy.get(document);
        if (other !== undefined && other !== item.id) findings.push(finding(path, text, "MED-011"));
        else narratedBy.set(document, item.id);
      }
      if (position === undefined) continue;
      if (previous !== undefined) {
        const order =
          previous.document === document
            ? position < previous.position
              ? "document"
              : undefined
            : spinePosition(document) < spinePosition(previous.document)
              ? "spine"
              : undefined;
        if (order !== undefined) {
          findings.push(finding(path, text, "MED-015", `${document}#${fragment}`, order));
        }
      }
      previous = { document, position };
    }
  }
  // Each narrated content document names its overlay, and each named overlay narrates it.
  const overlayIds = new Set(overlays.map(({ item }) => item.id));
  for (const item of context.items.values()) {
    const declared = Xml.attribute(item.element, "media-overlay")?.trim();
    const narrator = item.path === undefined ? undefined : narratedBy.get(item.path);
    const at = { line: item.element.line, column: item.element.column };
    if (narrator !== undefined && declared === undefined) {
      findings.push(finding(context.packagePath, at, "MED-010"));
    } else if (narrator !== undefined && declared !== narrator) {
      findings.push(finding(context.packagePath, at, "MED-012"));
    } else if (narrator === undefined && declared !== undefined && overlayIds.has(declared)) {
      findings.push(finding(context.packagePath, at, "MED-013"));
    }
  }
  return findings;
};

const ACTIVE_CLASS = "-epub-media-overlay-active";
const PLAYBACK_ACTIVE_CLASS = "-epub-media-overlay-playing";

// Styling class names: narrated documents need CSS for them (CSS-030), and CSS using the
// well-known names suggests declaring them (CSS-029).
export const styleFindings = (
  metadata: Metadata,
  documents: ReadonlyArray<{
    readonly item: ManifestItem;
    readonly path: string;
    readonly features: { readonly styled: boolean };
    readonly end: { readonly line: number; readonly column: number };
  }>,
  styleSheets: ReadonlyArray<{ readonly path: string; readonly css: string }>,
) => {
  const findings: Array<Finding> = [];
  if (metadata.activeClass !== undefined || metadata.playbackActiveClass !== undefined) {
    for (const document of documents) {
      const narrated = Xml.attribute(document.item.element, "media-overlay") !== undefined;
      if (narrated && !document.features.styled) {
        findings.push(finding(document.path, document.end, "CSS-030"));
      }
    }
  }
  const undeclared = [
    ...(metadata.activeClass === undefined ? [[ACTIVE_CLASS, "media:active-class"] as const] : []),
    ...(metadata.playbackActiveClass === undefined
      ? [[PLAYBACK_ACTIVE_CLASS, "media:playback-active-class"] as const]
      : []),
  ];
  for (const { path, css } of styleSheets) {
    for (const [name, property] of undeclared) {
      const index = css.search(new RegExp(`\\.${name}(?![\\w-])`));
      if (index < 0) continue;
      const before = css.slice(0, index).split("\n");
      const line = before.length;
      // Upstream points at the start of the rule.
      findings.push(finding(path, { line, column: 1 }, "CSS-029", name, property));
    }
  }
  return findings;
};
