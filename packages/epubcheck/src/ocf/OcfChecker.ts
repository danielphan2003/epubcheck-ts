import { pathToFileURL } from "node:url";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as JavaText from "../util/JavaText.ts";

import * as Profiles from "../profiles/Profiles.ts";
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
  // The publication's profile, with this package document's own `dc:type` values.
  readonly profile: Profiles.Selection;
}

export interface OcfResult {
  readonly container: Container.Container;
  readonly packageDocuments: ReadonlyArray<PackageDocument>;
  // Files container.xml declares: every rootfile, whatever its media type, and mapping documents.
  readonly declared: ReadonlyArray<string>;
  // The `mimetype` file's content, trimmed, which upstream's reports give as the format.
  readonly formatName: string | undefined;
  // Whether the check goes on to the package documents.
  readonly complete: boolean;
}

interface ContainerLinks {
  readonly rootfiles: ReadonlyArray<string>;
  // The last Rendition Mapping Document link, the only one upstream keeps.
  readonly mapping: string | undefined;
  readonly declared: ReadonlyArray<string>;
}

// Upstream ICU canonicalCaseFold: NFD, then full case folding. Lower-upper-lower approximates
// full folding, including `ß`/`ẞ` to `ss`.
const canonicalCaseFold = (name: string) =>
  name.normalize("NFD").toLowerCase().toUpperCase().toLowerCase();

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
    return undefined;
  }
  // Keep a byte order mark: upstream reads it as content.
  const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.value);
  if (JavaText.trim(content) !== "application/epub+zip") yield* report.message("PKG-007", at, "");
  else if (content !== "application/epub+zip") yield* report.message("PKG-007", at, "whitespace");
  return JavaText.trim(content);
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
  const version =
    peek.version === "3.0" ? ("3" as const) : peek.version === "2.0" ? ("2" as const) : undefined;
  if (version === undefined) return Result.fail("Version not supported");
  return Result.succeed({ version, types: Profiles.knownTypes(peek.types) });
});

const checkContainerFile = Effect.fn("OcfChecker.checkContainerFile")(function* (
  container: Container.Container,
  at: Report.Location,
  hadFatal: boolean,
) {
  const report = yield* Report.Report;
  if (!container.files.includes(CONTAINER_FILE)) {
    if (!hadFatal) yield* report.message("RSC-002", at);
    return Option.none<ContainerLinks>();
  }
  const document = yield* parseXml(container, CONTAINER_FILE);
  const none = { rootfiles: [], mapping: undefined, declared: [] };
  if (Option.isNone(document)) return Option.some<ContainerLinks>(none);
  const rootfiles: Array<string> = [];
  const declared: Array<string> = [];
  const mappings = [...Xml.descendants(document.value.root)]
    .filter(
      (element) =>
        element.ns === CONTAINER_NS &&
        element.local === "link" &&
        JavaText.trim(Xml.attribute(element, "rel") ?? "") === "mapping",
    )
    .flatMap((element) => {
      const href = Xml.attribute(element, "href")?.trim();
      return href === undefined || href === "" ? [] : [resolveRootfile(href)];
    });
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
    const rootfile = resolveRootfile(fullPath);
    if (mediaType === PACKAGE_MEDIA_TYPE) rootfiles.push(rootfile);
    // Upstream declares the rootfile's URL with its fragment, which no container file equals.
    if (!fullPath.includes("#")) declared.push(rootfile);
  }
  return Option.some<ContainerLinks>({
    rootfiles,
    mapping: mappings.at(-1),
    declared: [...declared, ...mappings],
  });
});

export const check = Effect.fn("OcfChecker.check")(function* (
  target: string,
  profile: Profiles.Profile = "default",
) {
  const report = yield* Report.Report;
  const path = yield* Path.Path;
  const at = Report.location(path.basename(target));
  const loaded = yield* loadContainer(target, at);
  if (Option.isNone(loaded)) return Option.none<OcfResult>();
  const container = loaded.value;

  yield* checkStructure(container, at);
  const formatName = yield* checkMimetype(container, at);
  // The container's own checks may stop the check before any package document.
  const stopped = Option.some<OcfResult>({
    container,
    packageDocuments: [],
    declared: [],
    formatName,
    complete: false,
  });
  const hadFatal = (yield* report.messages).some((message) => message.severity === "FATAL");
  const links = yield* checkContainerFile(container, at, hadFatal);
  if (Option.isNone(links)) return stopped;
  const rootfiles = links.value.rootfiles;

  const containerLocation = Report.location(CONTAINER_FILE);
  if (rootfiles.length === 0) {
    yield* report.message("RSC-003", containerLocation);
    return stopped;
  }
  const peeked: Array<{
    readonly path: string;
    readonly version: "2" | "3";
    readonly types: ReadonlySet<string>;
  }> = [];
  for (const [index, rootfile] of rootfiles.entries()) {
    if (!container.files.includes(rootfile)) {
      yield* report.message("OPF-002", containerLocation, rootfile);
      return stopped;
    }
    const peek = yield* peekVersion(container, rootfile);
    if (Result.isFailure(peek)) {
      yield* report.message("OPF-001", Report.location(rootfile), peek.failure);
      if (index === 0) return stopped;
      continue;
    }
    peeked.push({ path: rootfile, ...peek.success });
  }

  // Every declared rendition counts, including ones whose version could not be read.
  const first = peeked[0];
  const version = first?.version ?? "3";
  // Upstream's checkPublicationProfile: EPUB 2 has no profiles, and in EPUB 3 a known `dc:type`
  // (of the first package document that has one) overrides the requested profile.
  const firstTypes = peeked.find((document) => document.types.size > 0)?.types ?? new Set<string>();
  let effective = profile;
  if (version === "2") {
    if (profile !== "default" && first !== undefined)
      yield* report.message("PKG-023", Report.location(first.path));
    effective = "default";
  } else {
    effective = Profiles.effective(profile, firstTypes);
    if (effective !== profile && first !== undefined) {
      const type = Profiles.typeOf(effective);
      yield* report.message("OPF-064", Report.location(first.path), type, effective.toUpperCase());
    }
  }
  const packageDocuments = peeked.map(({ path, version, types }) => ({
    path,
    version,
    profile: { profile: effective, types },
  }));

  const multiple = rootfiles.length > 1;
  if (multiple) {
    if (version === "2") yield* report.message("PKG-013", containerLocation);
    else {
      if (!container.files.includes("META-INF/metadata.xml")) yield* report.message("RSC-019", at);
      const mapping = links.value.mapping;
      const bytes = mapping === undefined ? Option.none() : yield* readResource(container, mapping);
      if (mapping !== undefined && Option.isSome(bytes)) {
        yield* XmlChecker.check(bytes.value, mapping, Schemas.RENDITION_MAPPING);
      }
    }
  }

  // Validate META-INF files against their schemas: encryption first, then the others. Upstream
  // parses `metadata.xml` always, but checks its schemas only for multiple renditions.
  const metadataSchemas =
    version === "3" && multiple
      ? [
          ...Schemas.METADATA_30,
          ...(effective === "edupub" ? ["30/edupub/edu-ocf-metadata.sch"] : []),
        ]
      : [];
  const metaFiles: ReadonlyArray<readonly [string, ReadonlyArray<string>]> =
    version === "2"
      ? [
          ["META-INF/encryption.xml", Schemas.ENCRYPTION_20],
          [CONTAINER_FILE, Schemas.CONTAINER_20],
          ["META-INF/metadata.xml", metadataSchemas],
          ["META-INF/signatures.xml", Schemas.SIGNATURES_20],
        ]
      : [
          ["META-INF/encryption.xml", Schemas.ENCRYPTION_30],
          [CONTAINER_FILE, Schemas.CONTAINER_30],
          ["META-INF/metadata.xml", metadataSchemas],
          ["META-INF/signatures.xml", Schemas.SIGNATURES_30],
        ];
  // Upstream parses `metadata.xml` and `signatures.xml` without its XML handler (no HTM-001).
  const handled = new Set(["META-INF/encryption.xml", CONTAINER_FILE]);
  for (const [file, schemas] of metaFiles) {
    const bytes = yield* readResource(container, file);
    if (Option.isSome(bytes)) {
      yield* XmlChecker.check(bytes.value, file, schemas, { checksVersion: handled.has(file) });
    }
  }

  if (container.packaged) {
    const name = path.basename(target);
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 ? name.slice(dot + 1) : undefined;
    if (extension !== undefined && extension !== "epub") {
      // Upstream locates these at the archive's file URL.
      const url = { ...at, path: pathToFileURL(target).href };
      if (/^epub$/i.test(extension)) yield* report.message("PKG-016", url);
      else {
        yield* report.message(version === "3" ? "PKG-024" : "PKG-017", {
          ...url,
          context: extension,
        });
      }
    }
  }
  return Option.some<OcfResult>({
    container,
    packageDocuments,
    declared: links.value.declared,
    formatName,
    complete: true,
  });
});
