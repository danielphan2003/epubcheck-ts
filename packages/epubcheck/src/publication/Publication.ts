import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ContentChecker from "../content/ContentChecker.ts";
import * as ContentRules from "../content/ContentRules.ts";
import * as EpubType from "../content/EpubType.ts";
import * as FixedLayout from "../layout/FixedLayout.ts";
import * as MediaOverlays from "../overlays/MediaOverlays.ts";
import type * as Container from "../ocf/Container.ts";
import * as OcfChecker from "../ocf/OcfChecker.ts";
import type { ManifestItem, PackageDocument } from "../opf/PackageDocument.ts";
import * as Collect from "../references/Collect.ts";
import * as Profiles from "../profiles/Profiles.ts";
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

// Documents whose `epub:type` attributes are checked, by the media type upstream names them with.
const EPUB_TYPE_MEDIA_TYPES: Partial<Record<ContentChecker.ContentKind, string>> = {
  xhtml: "application/xhtml+xml",
  nav: "application/xhtml+xml",
  svg: "image/svg+xml",
  mo: "application/smil+xml",
};

// Compares an image's leading bytes with its declared media type and file name.
const checkImage = Effect.fn("Publication.checkImage")(function* (
  item: ManifestItem,
  path: string,
  bytes: Uint8Array,
) {
  const report = yield* Report.Report;
  const problems = MediaTypes.imageProblems(bytes, path, item.mediaType);
  for (const { id, args } of problems) yield* report.message(id, Report.location(path), ...args);
});

// Checks every resource a package document declares, in manifest order, then the references
// between them. Like upstream, each document's own findings come as it is read.
export const checkResources = Effect.fn("Publication.checkResources")(function* (
  container: Container.Container,
  opf: PackageDocument,
  selection: Profiles.Selection = Profiles.DEFAULT,
) {
  const report = yield* Report.Report;
  const inIndex = Profiles.indexPaths(opf.collections);
  const fixedIds = opf.version === "3" ? FixedLayout.fixedLayoutIds(opf) : new Set<string>();
  const fixedLayout = opf.version === "3" ? FixedLayout.fixedLayoutPaths(opf) : new Set<string>();
  // Upstream marks an item non-linear if any of its itemrefs is, or if it is outside the spine.
  const itemrefsOf = Map.groupBy(opf.spineItems, (itemref) => itemref.idref);
  const isStructured = (item: ManifestItem) =>
    !fixedIds.has(item.id) &&
    (itemrefsOf.get(item.id)?.every((itemref) => itemref.linear) ?? false);
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
  const mediaTypeOf = (target: Url.Target) =>
    target.kind === "local"
      ? publication.items.get(target.path)?.mediaType
      : target.kind === "remote"
        ? publication.remoteItems.get(target.url)?.mediaType
        : target.mediaType;
  const context: Collect.Context = {
    version: opf.version,
    container: true,
    mediaTypeOf,
    undeclaredClasses: MediaOverlays.undeclaredClasses(opf.metadata),
  };
  const narrators = new Map<string, string>();
  const references: Array<Collect.Reference> = [];
  let scripts = false;
  const positions = new Map<string, ReadonlyMap<string, number>>();
  const overlays: Array<{
    readonly item: ManifestItem;
    readonly path: string;
    readonly overlay: MediaOverlays.Overlay;
  }> = [];
  const documents: Array<{
    readonly item: ManifestItem;
    readonly path: string;
    readonly features: Collect.Features;
    readonly end: { readonly line: number; readonly column: number };
  }> = [];
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
      const text = new TextDecoder().decode(bytes.value);
      const css = Collect.fromCss(text, item.path, context);
      references.push(...css.references);
      yield* reportFindings(css.findings);
      yield* reportFindings(ReferenceChecker.styleSheetFindings(item, item.path, css.remote));
      continue;
    }
    if (kind === undefined) continue;
    const placed = {
      properties: item.properties,
      inIndex: inIndex.has(item.path),
      structured: isStructured(item),
    };
    const extraSchemas =
      opf.version !== "3"
        ? []
        : kind === "xhtml"
          ? Profiles.xhtmlSchemas(selection, placed)
          : kind === "nav"
            ? Profiles.navSchemas(selection, placed)
            : [];
    // Upstream's Search Key Map checker wants an `.xml` name, as written.
    if (kind === "skm" && !item.path.endsWith(".xml")) {
      yield* report.message("OPF-080", Report.location(item.path));
    }
    const document = yield* ContentChecker.check(
      bytes.value,
      item.path,
      kind,
      opf.version,
      extraSchemas,
    );
    if (Option.isSome(document) && kind === "skm") {
      const keys = Collect.fromSearchKeyMap(document.value, item.path, context);
      references.push(...keys.references);
      yield* reportFindings(keys.findings);
    }
    const typedAs = opf.version === "3" ? EPUB_TYPE_MEDIA_TYPES[kind] : undefined;
    if (Option.isSome(document) && typedAs !== undefined) {
      yield* reportFindings(EpubType.check(document.value, item.path, typedAs));
    }
    if (Option.isSome(document) && kind === "mo") {
      const read = MediaOverlays.read(document.value, item.path, {
        id: item.id,
        mediaTypeOf,
        narrators,
      });
      yield* reportFindings(read.findings);
      references.push(...read.references);
      overlays.push({ item, path: item.path, overlay: read.overlay });
    }
    if (Option.isNone(document) || kind === "mo" || kind === "ncx" || kind === "skm") continue;
    yield* reportFindings(ContentRules.schemeFindings(document.value, item.path, opf.version));
    if (opf.version === "3") {
      yield* reportFindings(
        ContentRules.check(document.value, item.path, kind === "svg" ? "svg" : "xhtml"),
      );
      const fixed = fixedLayout.has(item.path);
      yield* reportFindings(
        kind === "svg"
          ? FixedLayout.svgFindings(document.value, item.path, fixed)
          : FixedLayout.xhtmlFindings(document.value, item.path, fixed),
      );
    }
    const collected = Collect.fromDocument(document.value, item.path, context);
    references.push(...collected.references);
    ids.set(nfc(item.path), Collect.ids(document.value));
    yield* reportFindings(collected.findings);
    if (collected.features.scripts) scripts = true;
    positions.set(nfc(item.path), Collect.idPositions(document.value));
    const { root } = document.value;
    const end = { line: root.endLine, column: root.endColumn };
    documents.push({ item, path: item.path, features: collected.features, end });
    if (opf.version === "3") {
      yield* reportFindings(
        ReferenceChecker.propertyFindings(
          item,
          item.path,
          collected.features,
          end,
          kind !== "svg" && ReferenceChecker.loadsSvg(collected.references, publication),
        ),
      );
    }
  }
  const itemLocation = (item: ManifestItem) =>
    Report.location(opf.path, item.element.line, item.element.column);
  // EPUB 3 non-linear spine items must be reachable by a hyperlink, or perhaps by a script.
  // Upstream checks each item once, in manifest order; one non-linear itemref makes it non-linear.
  const hyperlinked = new Set(
    references.flatMap(({ type, target }) =>
      type === "hyperlink" && target.kind === "local" ? [target.path] : [],
    ),
  );
  const nonLinear = new Set(opf.spineItems.flatMap(({ idref, linear }) => (linear ? [] : [idref])));
  for (const item of opf.version === "3" ? byId.values() : []) {
    if (!nonLinear.has(item.id) || item.path === undefined) continue;
    if (!hyperlinked.has(nfc(item.path))) {
      yield* report.message(scripts ? "OPF-096b" : "OPF-096", itemLocation(item), item.path);
    }
  }
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
      const type = item.mediaType;
      if (
        /^(?:audio|video|font)\/|^application\/font-/.test(type) ||
        type === "application/x-shockwave-flash" ||
        type === "application/vnd.ms-opentype"
      ) {
        continue;
      }
      const name = Url.humanName(href);
      if (spine.has(item.id)) yield* report.message("RSC-006", itemLocation(item), name);
      else if (!referenced.has(Url.remoteKey(href))) {
        yield* report.message(scripts ? "RSC-006b" : "RSC-006", itemLocation(item), name);
      }
    }
  }
  yield* reportFindings(ReferenceChecker.check(references, publication));
  if (opf.version === "3") {
    yield* reportFindings(MediaOverlays.styleFindings(opf.metadata, documents));
    yield* reportFindings(
      MediaOverlays.publicationFindings(overlays, {
        items: publication.items,
        ids: positions,
        spine: opf.spine.flatMap((idref) => byId.get(idref)?.path ?? []).map(nfc),
        packagePath: opf.path,
        narrators,
        manifest: opf.items,
      }),
    );
  }
  if (opf.version === "3") {
    const dictionaries = new Set(
      documents.flatMap((document) =>
        document.features.dictionary === undefined ? [] : [nfc(document.path)],
      ),
    );
    // Each dictionary collection needs an XHTML document with dictionary content.
    for (const collection of opf.collections) {
      if (!collection.roles.includes("dictionary")) continue;
      const found = collection.links.some(
        ({ path }) =>
          path !== undefined &&
          publication.items.get(nfc(path))?.mediaType === "application/xhtml+xml" &&
          dictionaries.has(nfc(path)),
      );
      if (!found) yield* report.message("OPF-078", Report.location(opf.path));
    }
    // Upstream's checkSpecifics: dictionary content needs the type, and a dictionary needs content.
    const first = documents.find((document) => document.features.dictionary !== undefined);
    const at = first?.features.dictionary;
    if (first !== undefined && at !== undefined && !selection.types.has("DICTIONARY")) {
      yield* report.message("OPF-079", Report.location(first.path, at.line, at.column));
    }
    if (first === undefined && Profiles.isDictionary(selection)) {
      yield* report.message("OPF-078", Report.location(opf.path));
    }
  }
});

// A single content document: references need a publication, so only its URLs are checked.
export const checkDocumentReferences = Effect.fn("Publication.checkDocumentReferences")(function* (
  bytes: Uint8Array,
  path: string,
  kind: ContentChecker.ContentKind,
  version: "2" | "3",
  profile: Profiles.Profile = "default",
) {
  const selection = { ...Profiles.DEFAULT, profile };
  const extraSchemas =
    version !== "3"
      ? []
      : kind === "xhtml"
        ? Profiles.xhtmlSchemas(selection, undefined)
        : kind === "nav"
          ? Profiles.navSchemas(selection, undefined)
          : [];
  const document = yield* ContentChecker.check(bytes, path, kind, version, extraSchemas);
  const typedAs = version === "3" ? EPUB_TYPE_MEDIA_TYPES[kind] : undefined;
  if (Option.isSome(document) && typedAs !== undefined) {
    yield* reportFindings(EpubType.check(document.value, path, typedAs));
  }
  if (Option.isSome(document) && kind === "mo") {
    yield* reportFindings(MediaOverlays.read(document.value, path).findings);
  }
  if (Option.isNone(document) || kind === "mo" || kind === "ncx" || kind === "skm") return;
  yield* reportFindings(ContentRules.schemeFindings(document.value, path, version));
  if (version === "3") {
    yield* reportFindings(
      ContentRules.check(document.value, path, kind === "svg" ? "svg" : "xhtml"),
    );
  }
  const context: Collect.Context = {
    version,
    container: false,
    // A document checked alone has no package to declare the styling classes in.
    undeclaredClasses: MediaOverlays.undeclaredClasses({}),
  };
  yield* reportFindings(Collect.fromDocument(document.value, path, context).findings);
});
