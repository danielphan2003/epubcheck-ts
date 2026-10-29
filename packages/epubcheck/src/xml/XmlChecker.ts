import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as Report from "../report/Report.ts";
import * as Nvdl from "../schema/Nvdl.ts";
import * as Schemas from "../schema/Schemas.ts";
import { sources } from "../schema/sources.generated.ts";
import * as Xml from "./Xml.ts";

// Upstream resolves the XHTML 1.x DTDs from bundled copies, so their named entities are
// declared; all three use the XHTML 1.1 entity set.
const XHTML_DTDS = new Set([
  "-//W3C//DTD XHTML 1.1//EN",
  "-//W3C//DTD XHTML 1.0 Strict//EN",
  "-//W3C//DTD XHTML 1.0 Transitional//EN",
]);
const PREDEFINED = new Set(["lt", "gt", "amp", "apos", "quot"]);
let xhtmlEntities: Readonly<Record<string, string>> | undefined;

const entitiesOf = (doctype: Xml.XmlDoctype) => {
  if (doctype.publicId === undefined || !XHTML_DTDS.has(doctype.publicId)) return {};
  if (xhtmlEntities === undefined) {
    const entities: Record<string, string> = {};
    for (const match of (sources["20/dtd/xhtml11-ent.dtd"] ?? "").matchAll(
      /<!ENTITY\s+(\w+)\s+"([^"]*)"/g,
    )) {
      const [, name, value] = match;
      if (name === undefined || value === undefined || PREDEFINED.has(name)) continue;
      entities[name] = value.replace(/&#(x[0-9a-fA-F]+|\d+);/g, (_, code: string) =>
        String.fromCodePoint(
          code.startsWith("x") ? Number.parseInt(code.slice(1), 16) : Number(code),
        ),
      );
    }
    xhtmlEntities = entities;
  }
  return xhtmlEntities;
};

interface SchemaFinding {
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly informative?: boolean;
}

// The preprocessing and schema errors of a parsed document.
const validateDocument = (
  document: Xml.XmlDocument,
  path: string,
  schemas: ReadonlyArray<string>,
  prepare: ((document: Xml.XmlDocument) => Nvdl.Prepared) | undefined,
  informative: boolean,
) => {
  const prepared = prepare?.(document) ?? { document, errors: [] };
  const errors: Array<SchemaFinding> = [
    ...prepared.errors,
    ...(prepared.rejectedRoot === true
      ? []
      : Schemas.validate(prepared.document, schemas, `file:///${path}`)),
    // Upstream reports the strict SVG grammar's errors as informative usages.
    ...(informative
      ? Nvdl.svgSections(document).flatMap((section) =>
          Schemas.validate(section, ["30/epub-svg-30-informative.rnc"], `file:///${path}`).map(
            (error) => ({ ...error, informative: true }),
          ),
        )
      : []),
  ];
  return { findings: prepared.findings ?? [], errors };
};

// The walks over a document recurse; one nested too deeply to walk yields undefined instead
// of a stack overflow.
const withinStack = <A>(run: () => A) => {
  try {
    return run();
  } catch (cause) {
    if (cause instanceof RangeError) return undefined;
    throw cause;
  }
};

// Parses an XML resource and validates it against upstream schemas, reporting like upstream's
// XMLParser: well-formedness errors are fatal (RSC-016), schema errors are RSC-005, and
// Schematron messages prefixed "WARNING:" or "USAGE:" become RSC-017 and RSC-036, and strict
// SVG grammar errors are informative (RSC-025).
export const check = Effect.fn("XmlChecker.check")(function* (
  bytes: Uint8Array,
  path: string,
  schemas: ReadonlyArray<string>,
  prepare?: (document: Xml.XmlDocument) => Nvdl.Prepared,
  // EPUB 3 content documents: also check SVG against the strict grammar (RSC-025).
  informative = false,
) {
  const report = yield* Report.Report;
  const parsed = Xml.parse(Xml.decode(bytes), { externalEntities: entitiesOf });
  if (Result.isFailure(parsed)) {
    const { message, line, column } = parsed.failure;
    yield* report.message("RSC-016", Report.location(path, line, column), message);
    return Option.none<Xml.XmlDocument>();
  }
  const checked = withinStack(() =>
    validateDocument(parsed.success, path, schemas, prepare, informative),
  );
  // Upstream reports an item it fails to process this way, and skips its other checks.
  if (checked === undefined) {
    yield* report.message("CHK-008", Report.location(path), path);
    return Option.none<Xml.XmlDocument>();
  }
  for (const finding of checked.findings) {
    yield* report.message(
      finding.id,
      Report.location(path, finding.line, finding.column),
      ...finding.args,
    );
  }
  for (const error of checked.errors) {
    const at = Report.location(path, error.line, error.column);
    if (error.informative === true) {
      yield* report.message("RSC-025", at, error.message.trim());
      continue;
    }
    const message = error.message.trim();
    if (message.startsWith("WARNING:")) yield* report.message("RSC-017", at, message.slice(9));
    else if (message.startsWith("USAGE:")) yield* report.message("RSC-036", at, message.slice(7));
    else yield* report.message("RSC-005", at, message);
  }
  return Option.some(parsed.success);
});
