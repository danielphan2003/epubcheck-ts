import { type CheckResult, VERSION } from "../EpubCheck.ts";
import * as MessageCatalog from "../messages/MessageCatalog.ts";
import * as Dates from "./Dates.ts";
import * as Groups from "./Groups.ts";
import * as Jackson from "./Jackson.ts";
import type { Location, Message } from "./Report.ts";

// Follows the shape of upstream's JSON report. Fields not computed yet are null.

export interface ReportOptions {
  // The checked path as upstream's report states it (`./book.epub`).
  readonly path: string;
  // Where messages about the container itself are located.
  readonly containerPath: string;
  readonly maxOfEachMessage: number;
  // When the check started, in epoch milliseconds.
  readonly checkedAt: number;
  readonly elapsedTime: number;
  readonly customMessageFileName?: string | undefined;
}

export const epubVersionLabel = (version: "2" | "3") => (version === "3" ? "3.4" : "2.0.1");

// Messages about the container itself are located at the container's file name.
export const locationPath = (result: CheckResult, location: Location, displayPath: string) =>
  location.path === (result.path.split(/[\\/]/).pop() ?? result.path) ? displayPath : location.path;

export const render = (result: CheckResult, options: ReportOptions) => {
  const groups = Groups.group(result.messages, options.maxOfEachMessage).sort(Groups.byIdThenText);
  // Upstream counts messages as it groups them, by ID and text.
  const count = (severity: Message["severity"]) =>
    groups.filter((group) => group.first.severity === severity).length;
  const metadata = result.publication?.metadata;
  const summary = result.publication?.summary;
  return Jackson.stringify({
    messages: groups.map((group) => ({
      ID: MessageCatalog.displayId(group.first.id),
      severity: group.first.severity,
      message: group.first.message,
      additionalLocations: group.additionalLocations,
      locations: group.locations.map((location) => ({
        url: { opaque: false, hierarchical: true },
        path: locationPath(result, location, options.containerPath),
        line: location.line,
        column: location.column,
        context: location.context ?? null,
      })),
      suggestion: group.first.suggestion === "" ? null : group.first.suggestion,
    })),
    customMessageFileName: options.customMessageFileName ?? null,
    checker: {
      path: options.path,
      filename: options.path.split(/[\\/]/).pop() ?? options.path,
      checkerVersion: VERSION,
      checkDate: Dates.checkDate(options.checkedAt),
      elapsedTime: options.elapsedTime,
      nFatal: count("FATAL"),
      nError: count("ERROR"),
      nWarning: count("WARNING"),
      nUsage: count("USAGE"),
    },
    publication:
      result.publication === undefined
        ? null
        : {
            publisher: metadata?.publisher ?? null,
            title: metadata?.title ?? null,
            creator: metadata?.creators ?? [],
            // Upstream's `date` is the modification date; `dc:date` is not reported.
            date: metadata?.modified ?? null,
            subject: metadata?.subjects ?? [],
            description: metadata?.description ?? null,
            rights: metadata?.rights ?? null,
            identifier: metadata?.identifier ?? null,
            language: metadata?.language ?? null,
            nSpines: summary?.spineCount ?? null,
            checkSum: 0,
            renditionLayout: summary?.rendition.layout ?? null,
            renditionOrientation: summary?.rendition.orientation ?? null,
            renditionSpread: summary?.rendition.spread ?? null,
            ePubVersion: epubVersionLabel(result.publication.version),
            isScripted: summary?.scripted ?? null,
            hasFixedFormat: summary?.hasFixedFormat ?? null,
            isBackwardCompatible: null,
            hasAudio: summary?.hasAudio ?? null,
            hasVideo: summary?.hasVideo ?? null,
            charsCount: null,
            embeddedFonts: summary?.embeddedFonts ?? [],
            refFonts: summary?.remoteFonts ?? [],
            hasEncryption: summary?.hasEncryption ?? null,
            hasSignatures: summary?.hasSignatures ?? null,
            contributors: metadata?.contributors ?? [],
          },
    items: (summary?.items ?? []).map((item) => ({
      id: item.id,
      fileName: item.fileName,
      media_type: item.mediaType ?? null,
      compressedSize: item.compressedSize ?? null,
      uncompressedSize: item.uncompressedSize ?? null,
      compressionMethod: item.compressionMethod ?? null,
      checkSum: item.checkSum ?? null,
      isSpineItem: item.spine !== undefined,
      spineIndex: item.spine?.index ?? null,
      isLinear: item.spine?.linear ?? false,
      isFixedFormat: item.spine?.fixed ?? null,
      isScripted: item.scripted,
      renditionLayout: item.spine?.rendition.layout ?? null,
      renditionOrientation: item.spine?.rendition.orientation ?? null,
      renditionSpread: item.spine?.rendition.spread ?? null,
      referencedItems: item.referencedItems,
    })),
  });
};
