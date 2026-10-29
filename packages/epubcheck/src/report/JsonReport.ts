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
            nSpines: null,
            checkSum: null,
            renditionLayout: null,
            renditionOrientation: null,
            renditionSpread: null,
            ePubVersion: epubVersionLabel(result.publication.version),
            isScripted: null,
            hasFixedFormat: null,
            isBackwardCompatible: null,
            hasAudio: null,
            hasVideo: null,
            charsCount: null,
            embeddedFonts: [],
            refFonts: [],
            hasEncryption: null,
            hasSignatures: null,
            contributors: metadata?.contributors ?? [],
          },
    items: [],
  });
};
