import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Profiles from "../profiles/Profiles.ts";
import * as Report from "../report/Report.ts";
import * as Schemas from "../schema/Schemas.ts";
import * as XmlChecker from "../xml/XmlChecker.ts";
import * as Epub2Checks from "./Epub2Checks.ts";
import * as PackageChecks from "./PackageChecks.ts";
import * as PackageDocument from "./PackageDocument.ts";

// Checks a package document: schemas first, then the rules they cannot express. `container`
// lists the publication's files in a full check and is undefined when checking the file alone.
export const check = Effect.fn("OpfChecker.check")(function* (
  bytes: Uint8Array,
  path: string,
  version: "2" | "3",
  container?: ReadonlySet<string>,
  profile: Profiles.Selection = Profiles.DEFAULT,
) {
  const report = yield* Report.Report;
  const document = yield* XmlChecker.check(
    bytes,
    path,
    // Profile schemas follow `dc:type` in EPUB 2 too.
    [
      ...(version === "2" ? Schemas.PACKAGE_20 : Schemas.PACKAGE_30),
      ...Profiles.packageSchemas(profile),
    ],
    { version },
  );
  if (Option.isNone(document)) return Option.none<PackageDocument.PackageDocument>();
  const opf = PackageDocument.read(document.value, path, version);
  const context = { document: document.value, opf, container };
  const findings = [
    ...PackageChecks.check(context),
    ...(version === "2" ? Epub2Checks.check(context) : []),
  ];
  for (const finding of findings) {
    yield* report.message(
      finding.id,
      Report.location(finding.path ?? path, finding.line, finding.column),
      ...finding.args,
    );
  }
  return Option.some(opf);
});
