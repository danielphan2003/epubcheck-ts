import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ContentChecker from "../content/ContentChecker.ts";
import type * as Container from "../ocf/Container.ts";
import * as OcfChecker from "../ocf/OcfChecker.ts";
import type { ManifestItem, PackageDocument } from "../opf/PackageDocument.ts";
import * as Collect from "../references/Collect.ts";
import * as ReferenceChecker from "../references/ReferenceChecker.ts";
import * as Url from "../references/Url.ts";
import * as Report from "../report/Report.ts";
import * as MediaTypes from "../resources/MediaTypes.ts";

const reportFindings = Effect.fn("Publication.reportFindings")(function* (
  findings: ReadonlyArray<Collect.Finding>,
) {
  const report = yield* Report.Report;
  for (const finding of findings) {
    yield* report.message(
      finding.id,
      Report.location(finding.path, finding.line, finding.column),
      ...finding.args,
    );
  }
});

// Compares an image's leading bytes with its declared media type and file extension.
const checkImage = Effect.fn("Publication.checkImage")(function* (
  item: ManifestItem,
  path: string,
  bytes: Uint8Array,
) {
  const report = yield* Report.Report;
  const declared = MediaTypes.SNIFFED_TYPES[MediaTypes.parse(item.mediaType).essence];
  if (declared === undefined) return;
  const at = Report.location(path);
  if (bytes.length === 0) {
    yield* report.message("MED-004", at);
    return yield* report.message("PKG-021", at);
  }
  const actual = MediaTypes.sniffImage(bytes);
  if (actual !== declared) return yield* report.message("OPF-029", at, path, item.mediaType);
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  const knownElsewhere = Object.entries(MediaTypes.EXTENSIONS).some(
    ([format, extensions]) =>
      format !== actual && extension !== undefined && extensions.includes(extension),
  );
  if (extension !== undefined && knownElsewhere) {
    yield* report.message("PKG-022", at, actual, extension);
  }
});

// Checks every resource a package document declares, in manifest order, then the references
// between them. Like upstream, each document's own findings come as it is read.
export const checkResources = Effect.fn("Publication.checkResources")(function* (
  container: Container.Container,
  opf: PackageDocument,
) {
  const nfc = (path: string) => path.normalize("NFC");
  const byId = new Map(opf.items.map((item) => [item.id, item] as const));
  const ids = new Map<string, ReadonlySet<string>>();
  const unparsed = new Set<string>();
  const publication: ReferenceChecker.Publication = {
    version: opf.version,
    packagePath: nfc(opf.path),
    files: new Set(container.files.map(nfc)),
    items: new Map(
      opf.items.flatMap((item) =>
        item.path === undefined ? [] : [[nfc(item.path), item] as const],
      ),
    ),
    remoteItems: new Map(
      opf.items
        .filter((item) => item.path === undefined)
        .map((item) => [Url.remoteKey(item.href), item] as const),
    ),
    byId,
    spine: new Set(opf.spine.flatMap((idref) => byId.get(idref) ?? [])),
    ids,
    unparsed,
  };
  const context: Collect.Context = {
    version: opf.version,
    container: true,
    mediaTypeOf: (target) =>
      target.kind === "local"
        ? publication.items.get(target.path)?.mediaType
        : target.kind === "remote"
          ? publication.remoteItems.get(target.url)?.mediaType
          : undefined,
  };
  const references: Array<Collect.Reference> = [];
  let scripted = false;
  for (const item of opf.items) {
    // An item for the package document itself is OPF-099, not a content document.
    if (item.path === undefined || item.path === opf.path) continue;
    const kind = ContentChecker.kindOf(item.mediaType, item.properties, opf.version);
    const isCss = item.mediaType === "text/css";
    const isImage =
      MediaTypes.SNIFFED_TYPES[MediaTypes.parse(item.mediaType).essence] !== undefined;
    if (kind === undefined && !isCss && !isImage) continue;
    // A missing image is reported once, from the manifest (RSC-001).
    if (isImage && !publication.files.has(nfc(item.path))) continue;
    const bytes = yield* OcfChecker.readResource(container, item.path);
    if (Option.isNone(bytes)) continue;
    if (isImage) {
      yield* checkImage(item, item.path, bytes.value);
      continue;
    }
    if (isCss) {
      const css = Collect.fromCss(new TextDecoder().decode(bytes.value), item.path, context);
      references.push(...css.references);
      yield* reportFindings(css.findings);
      yield* reportFindings(ReferenceChecker.styleSheetFindings(item, item.path, css.remote));
      continue;
    }
    if (kind === undefined) continue;
    const document = yield* ContentChecker.check(bytes.value, item.path, kind, opf.version);
    if (Option.isNone(document)) unparsed.add(nfc(item.path));
    if (Option.isNone(document) || kind === "mo" || kind === "ncx") continue;
    const collected = Collect.fromDocument(document.value, item.path, context);
    references.push(...collected.references);
    ids.set(nfc(item.path), Collect.ids(document.value));
    yield* reportFindings(collected.findings);
    if (collected.features.scripted) scripted = true;
    if (opf.version === "3") {
      const { root } = document.value;
      yield* reportFindings(
        ReferenceChecker.propertyFindings(
          item,
          item.path,
          collected.features,
          { line: root.endLine, column: root.endColumn },
          kind !== "svg" && ReferenceChecker.loadsSvg(collected.references, publication),
        ),
      );
    }
  }
  yield* reportFindings(ReferenceChecker.check(references, publication));
  const report = yield* Report.Report;
  const itemLocation = (item: ManifestItem) =>
    Report.location(opf.path, item.element.line, item.element.column);
  // XHTML content documents must be in the container; a remote SVG may still be an image.
  for (const item of opf.items) {
    if (item.path !== undefined || !/^https?:/i.test(item.href)) continue;
    if (MediaTypes.parse(item.mediaType).essence === "application/xhtml+xml") {
      yield* report.message("RSC-006", itemLocation(item), item.href);
    }
  }
  // A remote resource no document references may still be fetched by a script.
  if (opf.version === "3" && scripted) {
    const referenced = new Set(
      references.flatMap(({ target }) => (target.kind === "remote" ? [target.url] : [])),
    );
    for (const item of opf.items) {
      const url = item.href.split("#")[0] ?? item.href;
      if (item.path !== undefined || !/^https?:/i.test(url)) continue;
      if (MediaTypes.parse(item.mediaType).essence === "application/xhtml+xml") continue;
      if (!referenced.has(Url.remoteKey(url))) {
        yield* report.message("RSC-006b", itemLocation(item), url);
      }
    }
  }
});

// A single content document: references need a publication, so only its URLs are checked.
export const checkDocumentReferences = Effect.fn("Publication.checkDocumentReferences")(function* (
  bytes: Uint8Array,
  path: string,
  kind: ContentChecker.ContentKind,
  version: "2" | "3",
) {
  const document = yield* ContentChecker.check(bytes, path, kind, version);
  if (Option.isNone(document) || kind === "mo" || kind === "ncx") return;
  const context: Collect.Context = { version, container: false };
  yield* reportFindings(Collect.fromDocument(document.value, path, context).findings);
});
