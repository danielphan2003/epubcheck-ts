import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as JavaText from "../util/JavaText.ts";

import * as Report from "../report/Report.ts";
import * as Schemas from "../schema/Schemas.ts";
import * as Xml from "../xml/Xml.ts";
import * as XmlChecker from "../xml/XmlChecker.ts";
import * as Container from "./Container.ts";
import * as FilenameChecker from "./FilenameChecker.ts";
import * as Zip from "./Zip.ts";

const CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container";
const CONTAINER_FILE = "META-INF/container.xml";
const PACKAGE_MEDIA_TYPE = "application/oebps-package+xml";

export interface PackageDocument {
  readonly path: string;
  readonly version: "2" | "3";
}

export interface OcfResult {
  readonly container: Container.Container;
  readonly packageDocuments: ReadonlyArray<PackageDocument>;
}

// Upstream ICU canonicalCaseFold: NFD, then full case folding. Lower-upper-lower approximates
// full folding, including `ß`/`ẞ` to `ss`.
const canonicalCaseFold = (name: string) =>
  name.normalize("NFD").toLowerCase().toUpperCase().toLowerCase();

// Java's String.trim strips U+0000 through U+0020 only.

// Container paths in container.xml are URLs relative to the container root.
const resolveRootfile = (fullPath: string) => {
  try {
    return decodeURIComponent(new URL(fullPath, "https://ocf.invalid/").pathname.slice(1));
  } catch {
    return fullPath;
  }
};

// Upstream checks the first 58 bytes of the archive, the mimetype entry's local header.
const checkZipHeader = Effect.fn("OcfChecker.checkZipHeader")(function* (
  bytes: Uint8Array,
  at: Report.Location,
) {
  const report = yield* Report.Report;
  if (bytes.length < 58) return yield* report.message("PKG-003", at);
  const uint16 = (offset: number) => (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
  const nameLength = uint16(26);
  const extraLength = uint16(28);
  // Upstream's test is `header[0] != 'P' && header[1] != 'K'`, so only both bytes wrong is corrupt.
  if (bytes[0] !== 0x50 && bytes[1] !== 0x4b) yield* report.message("PKG-004", at);
  else if (nameLength !== 8) yield* report.message("PKG-006", at);
  else if (extraLength !== 0) yield* report.message("PKG-005", at, String(extraLength));
  else if (new TextDecoder().decode(bytes.subarray(30, 38)) !== "mimetype") {
    yield* report.message("PKG-006", at);
  }
});

const loadContainer = Effect.fn("OcfChecker.loadContainer")(function* (
  target: string,
  at: Report.Location,
) {
  const fs = yield* FileSystem.FileSystem;
  const report = yield* Report.Report;
  const info = yield* fs.stat(target).pipe(Effect.option);
  if (Option.isSome(info) && info.value.type === "Directory") {
    return yield* Container.fromDirectory(target).pipe(
      Effect.asSome,
      Effect.catchTags({
        SymbolicLinkError: (error) =>
          report
            .message("PKG-008", at, error.message)
            .pipe(Effect.as(Option.none<Container.Container>())),
      }),
    );
  }
  const bytes = yield* fs.readFile(target).pipe(Effect.option);
  if (Option.isNone(bytes)) {
    yield* report.message("PKG-008", at, target);
    return Option.none<Container.Container>();
  }
  yield* checkZipHeader(bytes.value, at);
  if (bytes.value.length === 0) {
    yield* report.message("PKG-008", at, "zip file is empty");
    return Option.none<Container.Container>();
  }
  return yield* Zip.parse(bytes.value).pipe(
    Effect.map((archive) => Option.some(Container.fromZip(archive))),
    Effect.catchTags({
      ZipFormatError: (error) =>
        report
          .message(error.isCentralDirectoryError ? "PKG-027" : "PKG-008", at, error.message)
          .pipe(Effect.as(Option.none<Container.Container>())),
    }),
  );
});

// Reads a META-INF or package file, reporting an unreadable file as upstream's XMLParser does.
export const readResource = Effect.fn("OcfChecker.readResource")(function* (
  container: Container.Container,
  path: string,
) {
  const report = yield* Report.Report;
  return yield* container.read(path).pipe(
    Effect.catchTags({
      ResourceReadError: () =>
        report
          .message("PKG-008", Report.location(path), path)
          .pipe(Effect.as(Option.none<Uint8Array>())),
    }),
  );
});

const checkStructure = Effect.fn("OcfChecker.checkStructure")(function* (
  container: Container.Container,
  at: Report.Location,
) {
  const report = yield* Report.Report;
  const seen = new Set<string>();
  for (const file of container.files) {
    const folded = canonicalCaseFold(file);
    if (seen.has(folded)) yield* report.message("OPF-060", at, file);
    else seen.add(folded);
    // The container is checked before the publication version is known: EPUB 3 rules apply.
    for (const finding of FilenameChecker.checkFilename(file, "3")) {
      yield* report.message(finding.id, at, ...finding.args);
    }
  }
  for (const directory of container.directories) {
    if (!container.files.some((file) => file.startsWith(directory))) {
      yield* report.message("PKG-014", at, directory);
    }
  }
});

const checkMimetype = Effect.fn("OcfChecker.checkMimetype")(function* (
  container: Container.Container,
  at: Report.Location,
) {
  const report = yield* Report.Report;
  // Like upstream, an unreadable mimetype file is not reported here.
  const bytes = yield* container
    .read("mimetype")
    .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
  if (Option.isNone(bytes)) {
    // A packaged container's missing mimetype is already reported from its ZIP header.
    if (!container.packaged && !container.files.includes("mimetype")) {
      yield* report.message("PKG-006", Report.location("mimetype"));
    }
    return;
  }
  // Keep a byte order mark: upstream reads it as content.
  const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.value);
  if (JavaText.trim(content) !== "application/epub+zip") yield* report.message("PKG-007", at, "");
  else if (content !== "application/epub+zip") yield* report.message("PKG-007", at, "whitespace");
});

const parseXml = Effect.fn("OcfChecker.parseXml")(function* (
  container: Container.Container,
  path: string,
) {
  const report = yield* Report.Report;
  const bytes = yield* readResource(container, path);
  if (Option.isNone(bytes)) return Option.none<Xml.XmlDocument>();
  const document = Xml.parse(Xml.decode(bytes.value));
  if (Result.isFailure(document)) {
    const { message, line, column } = document.failure;
    yield* report.message("RSC-016", Report.location(path, line, column), message);
    return Option.none<Xml.XmlDocument>();
  }
  return Option.some(document.success);
});

// Reads the package document's `version` without validating the rest, as upstream does.
const peekVersion = Effect.fn("OcfChecker.peekVersion")(function* (
  container: Container.Container,
  path: string,
) {
  const report = yield* Report.Report;
  const bytes = yield* readResource(container, path);
  if (Option.isNone(bytes)) return Result.fail("Version not found");
  const peek = Xml.peekPackage(Xml.decode(bytes.value));
  if (peek.error !== undefined && peek.version === undefined) {
    const { message, line, column } = peek.error;
    yield* report.message("RSC-016", Report.location(path, line, column), message);
    return Result.fail("Version not found");
  }
  if (peek.root !== "package")
    return Result.fail("Package element must be the first element in the package file");
  if (peek.version === undefined) return Result.fail("Version attribute not found");
  if (peek.version === "3.0") return Result.succeed("3" as const);
  if (peek.version === "2.0") return Result.succeed("2" as const);
  return Result.fail("Version not supported");
});

const checkContainerFile = Effect.fn("OcfChecker.checkContainerFile")(function* (
  container: Container.Container,
  at: Report.Location,
  hadFatal: boolean,
) {
  const report = yield* Report.Report;
  if (!container.files.includes(CONTAINER_FILE)) {
    if (!hadFatal) yield* report.message("RSC-002", at);
    return Option.none<ReadonlyArray<string>>();
  }
  const document = yield* parseXml(container, CONTAINER_FILE);
  if (Option.isNone(document)) return Option.some<ReadonlyArray<string>>([]);
  const rootfiles: Array<string> = [];
  for (const element of Xml.descendants(document.value.root)) {
    if (element.ns !== CONTAINER_NS || element.local !== "rootfile") continue;
    const location = Report.location(CONTAINER_FILE, element.line, element.column);
    const fullPath = Xml.attribute(element, "full-path");
    if (fullPath === undefined) {
      yield* report.message("OPF-016", location);
      continue;
    }
    if (fullPath.trim() === "") {
      yield* report.message("OPF-017", location);
      continue;
    }
    const mediaType = (Xml.attribute(element, "media-type") ?? "unknown").trim().toLowerCase();
    if (mediaType === PACKAGE_MEDIA_TYPE) rootfiles.push(resolveRootfile(fullPath));
  }
  return Option.some<ReadonlyArray<string>>(rootfiles);
});

export const check = Effect.fn("OcfChecker.check")(function* (target: string) {
  const report = yield* Report.Report;
  const path = yield* Path.Path;
  const at = Report.location(path.basename(target));
  const loaded = yield* loadContainer(target, at);
  if (Option.isNone(loaded)) return Option.none<OcfResult>();
  const container = loaded.value;

  yield* checkStructure(container, at);
  yield* checkMimetype(container, at);
  const hadFatal = (yield* report.messages).some((message) => message.severity === "FATAL");
  const rootfiles = yield* checkContainerFile(container, at, hadFatal);
  if (Option.isNone(rootfiles)) return Option.none<OcfResult>();

  const containerLocation = Report.location(CONTAINER_FILE);
  if (rootfiles.value.length === 0) {
    yield* report.message("RSC-003", containerLocation);
    return Option.none<OcfResult>();
  }
  const packageDocuments: Array<PackageDocument> = [];
  for (const [index, rootfile] of rootfiles.value.entries()) {
    if (!container.files.includes(rootfile)) {
      yield* report.message("OPF-002", containerLocation, rootfile);
      return Option.none<OcfResult>();
    }
    const version = yield* peekVersion(container, rootfile);
    if (Result.isFailure(version)) {
      yield* report.message("OPF-001", Report.location(rootfile), version.failure);
      if (index === 0) return Option.none<OcfResult>();
      continue;
    }
    packageDocuments.push({ path: rootfile, version: version.success });
  }

  // Every declared rendition counts, including ones whose version could not be read.
  const version = packageDocuments[0]?.version ?? "3";
  if (rootfiles.value.length > 1) {
    if (version === "2") yield* report.message("PKG-013", containerLocation);
    else if (!container.files.includes("META-INF/metadata.xml"))
      yield* report.message("RSC-019", at);
  }

  // Validate META-INF files against their schemas: encryption first, then the others.
  const metaFiles: ReadonlyArray<readonly [string, ReadonlyArray<string>]> =
    version === "2"
      ? [
          ["META-INF/encryption.xml", Schemas.ENCRYPTION_20],
          [CONTAINER_FILE, Schemas.CONTAINER_20],
          ["META-INF/signatures.xml", Schemas.SIGNATURES_20],
        ]
      : [
          ["META-INF/encryption.xml", Schemas.ENCRYPTION_30],
          [CONTAINER_FILE, Schemas.CONTAINER_30],
          ["META-INF/metadata.xml", Schemas.METADATA_30],
          ["META-INF/signatures.xml", Schemas.SIGNATURES_30],
        ];
  for (const [file, schemas] of metaFiles) {
    const bytes = yield* readResource(container, file);
    if (Option.isSome(bytes)) yield* XmlChecker.check(bytes.value, file, schemas);
  }

  if (container.packaged) {
    const name = path.basename(target);
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 ? name.slice(dot + 1) : undefined;
    if (extension !== undefined && extension !== "epub") {
      if (/^epub$/i.test(extension)) yield* report.message("PKG-016", at);
      else {
        yield* report.message(version === "3" ? "PKG-024" : "PKG-017", {
          ...at,
          context: extension,
        });
      }
    }
  }
  return Option.some<OcfResult>({ container, packageDocuments });
});
