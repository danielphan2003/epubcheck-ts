import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ContentChecker from "../content/ContentChecker.ts";
import type * as Container from "../ocf/Container.ts";
import * as OcfChecker from "../ocf/OcfChecker.ts";
import type { PackageDocument } from "../opf/PackageDocument.ts";
import * as Collect from "../references/Collect.ts";
import * as ReferenceChecker from "../references/ReferenceChecker.ts";
import * as Url from "../references/Url.ts";
import * as Report from "../report/Report.ts";

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

// Checks every resource a package document declares, in manifest order, then the references
// between them. Like upstream, each document's own findings come as it is read.
export const checkResources = Effect.fn("Publication.checkResources")(function* (
  container: Container.Container,
  opf: PackageDocument,
) {
  const nfc = (path: string) => path.normalize("NFC");
  const context: Collect.Context = { version: opf.version, container: true };
  const byId = new Map(opf.items.map((item) => [item.id, item] as const));
  const ids = new Map<string, ReadonlySet<string>>();
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
    spine: new Set(opf.spine.flatMap((idref) => byId.get(idref) ?? [])),
    ids,
  };
  const references: Array<Collect.Reference> = [];
  for (const item of opf.items) {
    // An item for the package document itself is OPF-099, not a content document.
    if (item.path === undefined || item.path === opf.path) continue;
    const kind = ContentChecker.kindOf(item.mediaType, item.properties, opf.version);
    const isCss = item.mediaType === "text/css";
    if (kind === undefined && !isCss) continue;
    const bytes = yield* OcfChecker.readResource(container, item.path);
    if (Option.isNone(bytes)) continue;
    if (isCss) {
      const css = Collect.fromCss(new TextDecoder().decode(bytes.value), item.path, context);
      references.push(...css.references);
      yield* reportFindings(css.findings);
      yield* reportFindings(ReferenceChecker.styleSheetFindings(item, item.path, css.remote));
      continue;
    }
    if (kind === undefined) continue;
    const document = yield* ContentChecker.check(bytes.value, item.path, kind, opf.version);
    if (Option.isNone(document) || kind === "mo" || kind === "ncx") continue;
    const collected = Collect.fromDocument(document.value, item.path, context);
    references.push(...collected.references);
    ids.set(nfc(item.path), Collect.ids(document.value));
    yield* reportFindings(collected.findings);
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
