import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as Container from "../ocf/Container.ts";
import * as PackageChecks from "../opf/PackageChecks.ts";
import { type ManifestItem, type PackageDocument, registered } from "../opf/PackageDocument.ts";
import * as Url from "../references/Url.ts";
import { percentDecode } from "../util/UrlFragment.ts";
import * as Xml from "../xml/Xml.ts";
import type { Resources } from "./Publication.ts";

// What upstream's reports describe about a publication, rebuilt from the feature events it
// reports, in its order, and folded as its CheckingReport folds them: by file name, the last
// value winning, with defaults filled in at the end.

const NO_MANIFEST = "ePubCheck.NoManifestRef:";

// The state upstream's ItemMetadata keeps for one file.
interface Entry {
  id: string;
  readonly fileName: string;
  mediaType: string | undefined;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: "Stored" | "Deflated" | undefined;
  checkSum: string | undefined;
  spine: boolean;
  spineIndex: number | undefined;
  linear: boolean;
  fixed: boolean | undefined;
  scripted: boolean;
  layout: string | undefined;
  orientation: string | undefined;
  spread: string | undefined;
  readonly referenced: Set<string>;
}

// Upstream prints each digest byte in hex without zero-padding.
const checksum = Effect.fn("Summary.checksum")(function* (bytes: Uint8Array) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16)).join("");
});

// How upstream names a manifest item: a remote one by its URL, a data URL cut to 30 characters,
// and a local one by its decoded container path, in NFC, with any fragment.
const itemName = (item: ManifestItem) => {
  if (/^data:/i.test(item.href)) return `${item.href.replace(/[\t\n\f\r ]/g, "").slice(0, 30)}…`;
  if (item.path === undefined) return Url.humanName(item.href);
  const hash = item.href.indexOf("#");
  const fragment = hash < 0 ? "" : `#${percentDecode(item.href.slice(hash + 1))}`;
  return item.path.normalize("NFC") + fragment;
};

// A media overlay item, as the package document references it.
const overlayName = (overlay: ManifestItem) =>
  overlay.path === undefined
    ? Url.remoteKey(overlay.href)
    : Url.encodePath(overlay.path.normalize("NFC"));

// Upstream's itemref rendition properties, in its enum order: the last one present wins.
const OVERRIDES = {
  layout: ["pre-paginated", "reflowable"],
  orientation: ["auto", "landscape", "portrait"],
  spread: ["auto", "both", "landscape", "none", "portrait"],
} as const;

// `complete` says whether the check went on to the package documents; without a container,
// upstream still reports its defaults.
export const summarize = Effect.fn("Summary.summarize")(function* (
  container: Container.Container | undefined,
  renditions: ReadonlyArray<{ readonly opf: PackageDocument; readonly resources: Resources }>,
  complete: boolean,
) {
  const entries = new Map<string, Entry>();
  const entry = (fileName: string) => {
    const found = entries.get(fileName);
    if (found !== undefined) return found;
    const created: Entry = {
      id: "",
      fileName,
      mediaType: undefined,
      compressedSize: 0,
      uncompressedSize: 0,
      compressionMethod: undefined,
      checkSum: undefined,
      spine: false,
      spineIndex: undefined,
      linear: false,
      fixed: undefined,
      scripted: false,
      layout: undefined,
      orientation: undefined,
      spread: undefined,
      referenced: new Set(),
    };
    entries.set(fileName, created);
    return created;
  };
  const publication = {
    spineCount: 0,
    layout: "reflowable",
    orientation: "auto",
    spread: "auto",
    scripted: false,
    fixed: false,
    backwardCompatible: true,
    audio: false,
    video: false,
    characters: 0,
    embeddedFonts: new Set<string>(),
    remoteFonts: new Set<string>(),
  };
  const fixedLayout = (target: Entry | undefined) => {
    if (target !== undefined) target.fixed = true;
    publication.fixed = true;
    publication.backwardCompatible = false;
  };

  // The container reports every file's storage before any package document is read. An
  // expanded EPUB has no archive: upstream zips it to check it, which these sizes approximate.
  for (const file of container?.files ?? []) {
    if (container === undefined) break;
    const bytes = yield* container
      .read(file)
      .pipe(
        Effect.catchTags({ ResourceReadError: () => Effect.succeed(Option.none<Uint8Array>()) }),
      );
    if (Option.isNone(bytes)) continue;
    const storage = container.storage(file);
    const target = entry(file);
    target.uncompressedSize = storage?.size ?? bytes.value.length;
    target.compressedSize = storage?.compressedSize ?? bytes.value.length;
    target.compressionMethod = (storage?.compressed ?? file !== "mimetype") ? "Deflated" : "Stored";
    target.checkSum = yield* checksum(bytes.value);
  }

  for (const { opf, resources } of renditions) {
    // Upstream reports the global layout only when fixed, and the first orientation and spread
    // metas, refining or not; and rendition properties in EPUB 3 only.
    const epub3 = opf.version === "3";
    if (epub3) {
      const { layouts, orientation, spread } = opf.metadata;
      const layout = layouts.includes("pre-paginated")
        ? "pre-paginated"
        : layouts.includes("roll")
          ? "roll"
          : undefined;
      if (layout !== undefined) {
        publication.layout = layout;
        fixedLayout(undefined);
      }
      if (orientation !== undefined) publication.orientation = orientation;
      if (spread !== undefined) publication.spread = spread;
    }
    const items = [...registered(opf)];
    const byId = new Map(items.map((item) => [item.id, item] as const));
    // A spine without a known `toc` is not backward compatible.
    if (opf.hasSpine && (opf.toc === undefined || !byId.has(opf.toc))) {
      publication.backwardCompatible = false;
    }
    // Itemrefs count when their item is registered; one non-linear itemref makes it non-linear,
    // and their rendition properties add up.
    const itemrefs = opf.spineItems.filter((itemref) => byId.has(itemref.idref));
    const nonLinear = new Set(itemrefs.flatMap(({ idref, linear }) => (linear ? [] : [idref])));
    const properties = new Map<string, Set<string>>();
    for (const itemref of itemrefs) {
      if (itemref.padded) continue;
      const merged = properties.get(itemref.idref) ?? new Set<string>();
      for (const property of itemref.properties) merged.add(property);
      properties.set(itemref.idref, merged);
    }
    for (const item of items) {
      const target = entry(itemName(item));
      target.id = item.id;
      if (itemrefs.some((itemref) => itemref.idref === item.id)) {
        target.spine = true;
        target.linear = !nonLinear.has(item.id);
        publication.spineCount++;
      }
      const own = properties.get(item.id);
      if (!epub3 || own === undefined) continue;
      for (const kind of ["layout", "orientation", "spread"] as const) {
        for (const value of OVERRIDES[kind]) {
          if (!own.has(`rendition:${kind}-${value}`)) continue;
          target[kind] = value;
          // Either layout counts as fixed-layout information.
          if (kind === "layout") fixedLayout(target);
        }
      }
    }
    for (const item of items) {
      entry(itemName(item)).mediaType = item.mediaType;
      if (item.mediaType.startsWith("audio/")) publication.audio = true;
      else if (item.mediaType.startsWith("video/")) publication.video = true;
    }
    for (const [index, itemref] of itemrefs.entries()) {
      const item = byId.get(itemref.idref);
      if (item !== undefined) entry(itemName(item)).spineIndex = index;
    }
    // Documents report under their encoded paths, which may name no item.
    for (const path of resources.scripted) {
      entry(path).scripted = true;
      publication.scripted = true;
      publication.backwardCompatible = false;
    }
    for (const { path, count } of resources.characters) {
      entry(path);
      publication.characters += count;
    }
    for (const font of resources.fonts) {
      (font.embedded ? publication.embeddedFonts : publication.remoteFonts).add(font.name);
    }
    // Package references: its links, guide references, and in EPUB 3 the media overlays of
    // the items upstream's checkItem sees.
    const overlays = epub3
      ? PackageChecks.checkedItems(opf).flatMap((item) => {
          const overlay = byId.get(Xml.attribute(item.element, "media-overlay") ?? "");
          if (overlay === undefined) return [];
          return [{ from: Url.encodePath(opf.path.normalize("NFC")), to: overlayName(overlay) }];
        })
      : [];
    for (const { from, to } of [...resources.references, ...overlays]) {
      const target = entry(from);
      if (to !== target.fileName) target.referenced.add(to);
    }
  }

  // Upstream's defaults: unnamed files, and spine items without rendition overrides.
  const defaultFixed = publication.layout === "pre-paginated";
  const items = [...entries.values()].map((target) => ({
    ...target,
    id: target.id === "" ? `${NO_MANIFEST}${target.fileName}` : target.id,
    layout: target.spine ? (target.layout ?? publication.layout) : target.layout,
    orientation: target.spine
      ? (target.orientation ?? publication.orientation)
      : target.orientation,
    spread: target.spine ? (target.spread ?? publication.spread) : target.spread,
    fixed: target.spine ? (target.fixed ?? defaultFixed) : target.fixed,
    referenced: [...target.referenced].sort(),
  }));
  // Java's String.compareTo order.
  items.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    ...publication,
    embeddedFonts: [...publication.embeddedFonts],
    remoteFonts: [...publication.remoteFonts],
    hasEncryption: complete && container?.files.includes("META-INF/encryption.xml") === true,
    hasSignatures: complete && container?.files.includes("META-INF/signatures.xml") === true,
    items,
  };
});

export type PublicationSummary = Effect.Success<ReturnType<typeof summarize>>;
