import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ContentChecker from "../content/ContentChecker.ts";
import type * as Container from "../ocf/Container.ts";
import * as OcfChecker from "../ocf/OcfChecker.ts";
import type { ManifestItem, PackageDocument } from "../opf/PackageDocument.ts";
import * as Collect from "../references/Collect.ts";
import * as ReferenceChecker from "../references/ReferenceChecker.ts";
import * as Report from "../report/Report.ts";

const reportFindings = Effect.fnUntraced(function* (
  findings: ReadonlyArray<ReferenceChecker.Finding>,
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

// Checks every resource a package document declares, then the references between them.
export const checkResources = Effect.fn("Publication.checkResources")(function* (
  container: Container.Container,
  opf: PackageDocument,
) {
  const references: Array<Collect.Reference> = [];
  const ids = new Map<string, ReadonlySet<string>>();
  const documents: Array<{
    readonly item: ManifestItem;
    readonly path: string;
    readonly features: Collect.Features;
  }> = [];
  for (const item of opf.items) {
    // An item for the package document itself is OPF-099, not a content document.
    if (item.path === undefined || item.path === opf.path) continue;
    const kind = ContentChecker.kindOf(item.mediaType, item.properties, opf.version);
    const isCss = item.mediaType === "text/css";
    if (kind === undefined && !isCss) continue;
    const bytes = yield* OcfChecker.readResource(container, item.path);
    if (Option.isNone(bytes)) continue;
    if (isCss) {
      references.push(...Collect.fromCss(new TextDecoder().decode(bytes.value), item.path));
      continue;
    }
    if (kind === undefined) continue;
    const document = yield* ContentChecker.check(bytes.value, item.path, kind, opf.version);
    if (Option.isNone(document) || kind === "mo" || kind === "ncx") continue;
    const collected = Collect.fromDocument(document.value, item.path);
    references.push(...collected.references);
    ids.set(item.path, Collect.ids(document.value));
    documents.push({ item, path: item.path, features: collected.features });
  }
  const byId = new Map(opf.items.map((item) => [item.id, item] as const));
  const nfc = (path: string) => path.normalize("NFC");
  const publication: ReferenceChecker.Publication = {
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
        .map((item) => [item.href.split("#")[0] ?? item.href, item] as const),
    ),
    spine: new Set(opf.spine.flatMap((idref) => byId.get(idref)?.path ?? []).map(nfc)),
    ids: new Map([...ids].map(([path, found]) => [nfc(path), found] as const)),
  };
  const result = ReferenceChecker.check(references, publication);
  yield* reportFindings(result.findings);
  if (opf.version === "3") {
    for (const document of documents) {
      yield* reportFindings(
        ReferenceChecker.propertyFindings(
          document.item,
          document.path,
          document.features,
          result.remoteUsers.has(document.path),
        ),
      );
    }
  }
});

// A single content document: only the URL rules that need no publication apply.
export const checkDocumentReferences = Effect.fn("Publication.checkDocumentReferences")(function* (
  bytes: Uint8Array,
  path: string,
  kind: ContentChecker.ContentKind,
  version: "2" | "3",
) {
  const document = yield* ContentChecker.check(bytes, path, kind, version);
  if (Option.isNone(document) || kind === "mo" || kind === "ncx") return;
  yield* reportFindings(
    ReferenceChecker.check(Collect.fromDocument(document.value, path).references, undefined)
      .findings,
  );
});
