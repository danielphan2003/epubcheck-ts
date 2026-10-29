import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as FixedLayout from "../layout/FixedLayout.ts";
import type * as Container from "../ocf/Container.ts";
import type { PackageDocument } from "../opf/PackageDocument.ts";
import type { Resources } from "./Publication.ts";

// What upstream's reports describe about a publication: its rendition properties, fonts, and
// every container file and manifest item with its storage, checksum, spine position and links.

export interface Rendition {
  readonly layout: string;
  readonly orientation: string;
  readonly spread: string;
}

export interface ItemSummary {
  readonly id: string;
  readonly fileName: string;
  readonly mediaType: string | undefined;
  readonly compressedSize: number | undefined;
  readonly uncompressedSize: number | undefined;
  readonly compressionMethod: "Stored" | "Deflated" | undefined;
  readonly checkSum: string | undefined;
  readonly spine:
    | {
        readonly index: number;
        readonly linear: boolean;
        readonly fixed: boolean;
        readonly rendition: Rendition;
      }
    | undefined;
  readonly scripted: boolean;
  readonly referencedItems: ReadonlyArray<string>;
}

export interface PublicationSummary {
  readonly spineCount: number;
  readonly rendition: Rendition;
  readonly hasFixedFormat: boolean;
  readonly scripted: boolean;
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
  readonly hasEncryption: boolean;
  readonly hasSignatures: boolean;
  readonly embeddedFonts: ReadonlyArray<string>;
  readonly remoteFonts: ReadonlyArray<string>;
  readonly items: ReadonlyArray<ItemSummary>;
}

// Upstream prints each digest byte in hex without zero-padding.
const checksum = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16)).join("");
});

const NO_MANIFEST = "ePubCheck.NoManifestRef:";

export const summarize = Effect.fn("Summary.summarize")(function* (
  container: Container.Container,
  opf: PackageDocument,
  resources: Resources,
) {
  const stored = Effect.fnUntraced(function* (path: string) {
    const bytes = yield* container
      .read(path)
      .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    const storage = container.storage(path);
    if (Option.isNone(bytes)) {
      return {
        compressedSize: undefined,
        uncompressedSize: undefined,
        compressionMethod: undefined,
        checkSum: undefined,
      };
    }
    // An expanded EPUB has no archive; upstream reports the one it builds, mimetype stored.
    const compressed = storage?.compressed ?? path !== "mimetype";
    return {
      compressedSize: storage?.compressedSize ?? bytes.value.length,
      uncompressedSize: storage?.size ?? bytes.value.length,
      compressionMethod: compressed ? ("Deflated" as const) : ("Stored" as const),
      checkSum: yield* checksum(bytes.value),
    };
  });
  const spineIndex = new Map(
    opf.spineItems.map((itemref, index) => [itemref.idref, { itemref, index }] as const),
  );
  const items: Array<ItemSummary> = [];
  const declared = new Set<string>();
  for (const item of opf.items) {
    if (item.path !== undefined) declared.add(item.path);
    const entry = spineIndex.get(item.id);
    const rendition =
      entry === undefined
        ? undefined
        : FixedLayout.rendition(entry.itemref.properties, opf.metadata);
    items.push({
      id: item.id,
      fileName: item.path ?? item.href,
      mediaType: item.mediaType,
      ...(item.path === undefined
        ? {
            compressedSize: undefined,
            uncompressedSize: undefined,
            compressionMethod: undefined,
            checkSum: undefined,
          }
        : yield* stored(item.path)),
      spine:
        entry === undefined || rendition === undefined
          ? undefined
          : {
              index: entry.index,
              linear: entry.itemref.linear,
              fixed: rendition.fixed,
              rendition: {
                layout: rendition.layout,
                orientation: rendition.orientation,
                spread: rendition.spread,
              },
            },
      scripted: item.path !== undefined && resources.scripted.has(item.path),
      referencedItems: item.path === undefined ? [] : (resources.targets.get(item.path) ?? []),
    });
  }
  for (const file of container.files) {
    if (declared.has(file)) continue;
    items.push({
      id: `${NO_MANIFEST}${file}`,
      fileName: file,
      mediaType: undefined,
      ...(yield* stored(file)),
      spine: undefined,
      scripted: false,
      referencedItems: [],
    });
  }
  // Java's String.compareTo order.
  items.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const global = FixedLayout.rendition([], opf.metadata);
  const essences = opf.items.map(
    (item) => item.mediaType.split(";")[0]?.trim().toLowerCase() ?? "",
  );
  return {
    spineCount: opf.spineItems.length,
    rendition: { layout: global.layout, orientation: global.orientation, spread: global.spread },
    hasFixedFormat: items.some((item) => item.spine?.fixed === true),
    scripted: resources.scripted.size > 0,
    hasAudio: essences.some((type) => type.startsWith("audio/")),
    hasVideo: essences.some((type) => type.startsWith("video/")),
    hasEncryption: container.files.includes("META-INF/encryption.xml"),
    hasSignatures: container.files.includes("META-INF/signatures.xml"),
    embeddedFonts: resources.embeddedFonts,
    remoteFonts: resources.remoteFonts,
    items,
  } satisfies PublicationSummary;
});
