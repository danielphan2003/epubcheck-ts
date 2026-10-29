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

// Compares an image's leading bytes with its declared media type and file name.
const checkImage = Effect.fn("Publication.checkImage")(function* (
  item: ManifestItem,
  path: string,
  bytes: Uint8Array,
) {
  const report = yield* Report.Report;
  const problems = MediaTypes.imageProblems(bytes, path, MediaTypes.normalize(item.mediaType));
  for (const { id, args } of problems) yield* report.message(id, Report.location(path), ...args);
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
    const isImage = MediaTypes.isBitmap(item.mediaType);
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
  // Upstream's rule for remote items: only audio, video, Flash and fonts may be remote. A remote
  // spine item is an error, and so is any other remote item no reference loads, unless a script
  // might fetch it.
  if (opf.version === "3") {
    const referenced = new Set(
      references.flatMap(({ target }) => (target.kind === "remote" ? [target.url] : [])),
    );
    const spine = new Set(opf.spine);
    for (const item of opf.items) {
      const href = item.href.trim();
      if (item.path !== undefined || href === "" || /^data:/i.test(href)) continue;
      const type = MediaTypes.normalize(item.mediaType);
      if (
        /^(?:audio|video|font)\/|^application\/font-/.test(type) ||
        type === "application/x-shockwave-flash" ||
        type === "application/vnd.ms-opentype"
      ) {
        continue;
      }
      if (spine.has(item.id)) yield* report.message("RSC-006", itemLocation(item), href);
      else if (!referenced.has(Url.remoteKey(href))) {
        yield* report.message(scripted ? "RSC-006b" : "RSC-006", itemLocation(item), href);
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
