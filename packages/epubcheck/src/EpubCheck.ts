import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { isMessageId, type Severity } from "./messages/MessageCatalog.ts";
import * as OcfChecker from "./ocf/OcfChecker.ts";
import * as OpfChecker from "./opf/OpfChecker.ts";
import * as PackageDocument from "./opf/PackageDocument.ts";
import * as Profiles from "./profiles/Profiles.ts";
import * as Publication from "./publication/Publication.ts";
import * as Summary from "./publication/Summary.ts";
import * as Url from "./references/Url.ts";
import * as Report from "./report/Report.ts";

// Upstream checker modes: a full publication (packaged or expanded) or a single document.
// The upstream release whose behavior this implements; reports and the CLI show it as the version.
export const VERSION = "5.4.0";

export const CheckMode = Schema.Literals(["epub", "opf", "xhtml", "svg", "nav", "mo"]);
export type CheckMode = typeof CheckMode.Type;

export const EpubVersion = Schema.Literals(["2", "3"]);
export type EpubVersion = typeof EpubVersion.Type;

export const Profile = Schema.Literals(["default", "edupub", "dict", "idx", "preview"]);
export type Profile = typeof Profile.Type;

export const CheckRequest = Schema.Struct({
  path: Schema.String,
  mode: Schema.optionalKey(CheckMode),
  version: Schema.optionalKey(EpubVersion),
  profile: Schema.optionalKey(Profile),
  locale: Schema.optionalKey(Schema.String),
  reportingLevel: Schema.optionalKey(
    Schema.Literals(["FATAL", "ERROR", "WARNING", "USAGE", "INFO"]),
  ),
  // Upstream's `--customMessages`: severity, message and suggestion overrides by message ID.
  overrides: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        severity: Schema.Literals(["FATAL", "ERROR", "WARNING", "USAGE", "INFO", "SUPPRESSED"]),
        message: Schema.optionalKey(Schema.String),
        suggestion: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
export interface CheckRequest extends Schema.Schema.Type<typeof CheckRequest> {}
export type Override = NonNullable<CheckRequest["overrides"]>[string];

export interface PublicationInfo {
  readonly version: EpubVersion;
  readonly metadata: PackageDocument.Metadata | undefined;
}

export interface CheckResult {
  readonly path: string;
  readonly mode: CheckMode;
  // What the package document declares, when the publication's version could be read.
  readonly publication?: PublicationInfo | undefined;
  // What upstream's reports describe of the publication and its files, once its container opens.
  readonly summary?: Summary.PublicationSummary | undefined;
  // When the container was made, and its `mimetype`, as upstream's XML reports state them.
  readonly created?: string | undefined;
  readonly formatName?: string | undefined;
  readonly messages: ReadonlyArray<Report.Message>;
}

// Upstream CheckerMode.fromExtension: anything without a known document extension is a publication.
export const inferMode = (path: string): CheckMode => {
  const dot = path.lastIndexOf(".");
  const extension = dot > 0 ? path.slice(dot + 1) : "epub";
  switch (extension) {
    case "opf":
      return "opf";
    case "xhtml":
    case "html":
    case "htm":
      return "xhtml";
    case "svg":
      return "svg";
    case "smil":
      return "mo";
    default:
      return "epub";
  }
};

export const countBySeverity = (messages: ReadonlyArray<Report.Message>, severity: Severity) =>
  messages.filter((message) => message.severity === severity).length;

export class EpubCheck extends Context.Service<
  EpubCheck,
  { readonly check: (request: CheckRequest) => Effect.Effect<CheckResult> }
>()("epubcheck-ts/EpubCheck") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const checkPublication = Effect.fn("EpubCheck.checkPublication")(function* (
    target: string,
    profile: Profile,
  ) {
    const report = yield* Report.Report;
    // Upstream's reports describe a publication it cannot open with their defaults.
    const unopened = {
      publication: undefined,
      created: undefined,
      formatName: undefined,
      summary: yield* Summary.summarize(undefined, [], false),
    };
    const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      yield* report.message("PKG-018", Report.location(path.basename(target)));
      return unopened;
    }
    const ocf = yield* OcfChecker.check(target, profile);
    if (Option.isNone(ocf)) return unopened;
    const { created } = ocf.value.container;
    const { formatName } = ocf.value;
    let metadata: PackageDocument.Metadata | undefined;
    // Upstream counts files container.xml declares, manifest items with an ID (the last of each
    // ID) and no fragment, and the files EPUB 3 package metadata links to.
    const declared = new Set(ocf.value.declared.map((file) => file.normalize("NFC")));
    const renditions: Array<{
      readonly opf: PackageDocument.PackageDocument;
      readonly resources: Publication.Resources;
    }> = [];
    for (const packageDocument of ocf.value.packageDocuments) {
      const bytes = yield* OcfChecker.readResource(ocf.value.container, packageDocument.path);
      if (Option.isNone(bytes)) continue;
      const opfResult = yield* OpfChecker.check(
        bytes.value,
        packageDocument.path,
        packageDocument.version,
        new Set(ocf.value.container.files),
        packageDocument.profile,
      );
      if (Option.isNone(opfResult)) continue;
      metadata ??= opfResult.value.metadata;
      for (const file of PackageDocument.declaredPaths(opfResult.value)) declared.add(file);
      if (opfResult.value.version === "3") {
        for (const link of opfResult.value.links) {
          if (link.path !== undefined) declared.add(link.path.normalize("NFC"));
        }
      }
      const resources = yield* Publication.checkResources(
        ocf.value.container,
        opfResult.value,
        packageDocument.profile,
      );
      renditions.push({ opf: opfResult.value, resources });
    }
    const summary = yield* Summary.summarize(ocf.value.container, renditions, ocf.value.complete);
    // Container files no package document declares (OCF files aside) are reported as usages.
    for (const file of ocf.value.complete ? ocf.value.container.files : []) {
      if (
        file === "mimetype" ||
        file.startsWith("META-INF/") ||
        declared.has(file.normalize("NFC"))
      ) {
        continue;
      }
      yield* report.message(
        "OPF-003",
        Report.location(path.basename(target)),
        Url.encodePath(file.normalize("NFC")),
      );
    }
    const first = ocf.value.packageDocuments[0];
    const publication =
      first === undefined
        ? undefined
        : ({ version: first.version, metadata } satisfies PublicationInfo);
    return { publication, created, formatName, summary };
  });

  // Single-document modes check one file outside any publication, as upstream's `--mode`.
  const checkDocument = Effect.fn("EpubCheck.checkDocument")(function* (
    target: string,
    mode: Exclude<CheckMode, "epub">,
    version: EpubVersion,
    profile: Profile,
  ) {
    const report = yield* Report.Report;
    const name = path.basename(target);
    const bytes = yield* fs.readFile(target).pipe(Effect.option);
    if (Option.isNone(bytes))
      return yield* report.message("PKG-008", Report.location(name), target);
    if (mode === "opf") {
      yield* OpfChecker.check(bytes.value, name, version, undefined, {
        ...Profiles.DEFAULT,
        profile,
      });
    } else yield* Publication.checkDocumentReferences(bytes.value, name, mode, version, profile);
  });

  const check = Effect.fn("EpubCheck.check")(function* (request: CheckRequest) {
    const mode = request.mode ?? inferMode(request.path);
    const target = path.resolve(request.path);
    const overrides = new Map(
      Object.entries(request.overrides ?? {}).flatMap(([id, override]) =>
        isMessageId(id) ? [[id, override] as const] : [],
      ),
    );
    const report = yield* Report.make({
      locale: request.locale,
      reportingLevel: request.reportingLevel,
      overrides,
    });
    const profile = request.profile ?? "default";
    // A single document has no publication to describe.
    const checked =
      mode === "epub"
        ? yield* checkPublication(target, profile).pipe(
            Effect.provideService(Report.Report, report),
            Effect.provide(platform),
          )
        : yield* checkDocument(target, mode, request.version ?? "3", profile).pipe(
            Effect.provideService(Report.Report, report),
            Effect.provide(platform),
          );
    return {
      path: target,
      mode,
      ...(checked === undefined ? {} : checked),
      messages: yield* report.messages,
    } satisfies CheckResult;
  });

  return EpubCheck.of({ check });
});

export const layer = Layer.effect(EpubCheck, make);
