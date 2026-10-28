import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as Report from "../report/Report.ts";
import type * as Nvdl from "../schema/Nvdl.ts";
import * as Schemas from "../schema/Schemas.ts";
import * as Xml from "./Xml.ts";

// Parses an XML resource and validates it against upstream schemas, reporting like upstream's
// XMLParser: well-formedness errors are fatal (RSC-016), schema errors are RSC-005, and
// Schematron messages prefixed "WARNING:" or "USAGE:" become RSC-017 and RSC-036.
export const check = Effect.fn("XmlChecker.check")(function* (
  bytes: Uint8Array,
  path: string,
  schemas: ReadonlyArray<string>,
  prepare?: (document: Xml.XmlDocument) => Nvdl.Prepared,
) {
  const report = yield* Report.Report;
  const parsed = Xml.parse(Xml.decode(bytes));
  if (Result.isFailure(parsed)) {
    const { message, line, column } = parsed.failure;
    yield* report.message("RSC-016", Report.location(path, line, column), message);
    return Option.none<Xml.XmlDocument>();
  }
  const prepared = prepare?.(parsed.success) ?? { document: parsed.success, errors: [] };
  for (const finding of prepared.findings ?? []) {
    yield* report.message(
      finding.id,
      Report.location(path, finding.line, finding.column),
      ...finding.args,
    );
  }
  const errors = [
    ...prepared.errors,
    ...Schemas.validate(prepared.document, schemas, `file:///${path}`),
  ];
  for (const error of errors) {
    const at = Report.location(path, error.line, error.column);
    const message = error.message.trim();
    if (message.startsWith("WARNING:")) yield* report.message("RSC-017", at, message.slice(9));
    else if (message.startsWith("USAGE:")) yield* report.message("RSC-036", at, message.slice(7));
    else yield* report.message("RSC-005", at, message);
  }
  return Option.some(parsed.success);
});
