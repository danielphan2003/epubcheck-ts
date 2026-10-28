import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { Severity } from "./messages/MessageCatalog.ts";
import * as OcfChecker from "./ocf/OcfChecker.ts";
import * as Report from "./report/Report.ts";

// Upstream checker modes: a full publication (packaged or expanded) or a single document.
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
});
export interface CheckRequest extends Schema.Schema.Type<typeof CheckRequest> {}

export interface CheckResult {
  readonly path: string;
  readonly mode: CheckMode;
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

  const checkPublication = Effect.fn("EpubCheck.checkPublication")(function* (target: string) {
    const report = yield* Report.Report;
    const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* report.message("PKG-018", Report.location(path.basename(target)));
    }
    yield* OcfChecker.check(target);
  });

  const check = Effect.fn("EpubCheck.check")(function* (request: CheckRequest) {
    const mode = request.mode ?? inferMode(request.path);
    const target = path.resolve(request.path);
    const report = yield* Report.make({
      locale: request.locale,
      reportingLevel: request.reportingLevel,
    });
    if (mode === "epub") {
      yield* checkPublication(target).pipe(
        Effect.provideService(Report.Report, report),
        Effect.provide(platform),
      );
    }
    return { path: target, mode, messages: yield* report.messages } satisfies CheckResult;
  });

  return EpubCheck.of({ check });
});

export const layer = Layer.effect(EpubCheck, make);
