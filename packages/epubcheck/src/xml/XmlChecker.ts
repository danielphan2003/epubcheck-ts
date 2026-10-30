import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as Report from "../report/Report.ts";
import * as Nvdl from "../schema/Nvdl.ts";
import * as Schemas from "../schema/Schemas.ts";
import { sources } from "../schema/sources.generated.ts";
import * as Xml from "./Xml.ts";

// In EPUB 2, upstream resolves the XHTML 1.1 DTD's system ID from a bundled copy, which declares
// its named entities, whatever the public ID. Other DTDs, and every DTD in EPUB 3, are not
// resolved, so named entities are undeclared.
const XHTML11_SYSTEM_ID = "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd";
const PREDEFINED = new Set(["lt", "gt", "amp", "apos", "quot"]);
let xhtmlEntities: Readonly<Record<string, string>> | undefined;

const entitiesOf = (doctype: Xml.XmlDoctype, version: "2" | "3" | undefined) => {
  if (version !== "2") return {};
  if (doctype.systemId !== XHTML11_SYSTEM_ID) return {};
  if (xhtmlEntities === undefined) {
    const entities: Record<string, string> = {};
    for (const match of (sources["20/dtd/xhtml11-ent.dtd"] ?? "").matchAll(
      /<!ENTITY\s+(\w+)\s+"([^"]*)"/g,
    )) {
      const [, name, value] = match;
      if (name === undefined || value === undefined || PREDEFINED.has(name)) continue;
      entities[name] = Xml.decodeCharacterReferences(value);
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

// The preprocessing, NVDL and validation walks recurse, so a document nested more than about a
// thousand levels deep overflows the stack; that yields undefined instead of a crash.
const withinStack = <A>(run: () => A) => {
  try {
    return run();
  } catch (cause) {
    if (cause instanceof RangeError && cause.message.includes("call stack")) return undefined;
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
  options: {
    readonly prepare?: ((document: Xml.XmlDocument) => Nvdl.Prepared) | undefined;
    // XHTML content documents report UTF-16 as HTM-058 instead of RSC-027.
    readonly isXhtml?: boolean;
    // EPUB 3 content documents: also check SVG against the strict grammar (RSC-025).
    readonly informative?: boolean;
    // The publication's EPUB version, which decides the DTDs upstream resolves.
    readonly version?: "2" | "3";
    // Upstream checks the XML version (HTM-001) only where its XML handler parses the file.
    readonly checksVersion?: boolean;
  } = {},
) {
  const { prepare, isXhtml = false, informative = false, version, checksVersion = true } = options;
  const report = yield* Report.Report;
  const decoded = Xml.decodeDocument(bytes);
  if (decoded.encoding === "UTF-16") {
    yield* report.message(isXhtml ? "HTM-058" : "RSC-027", Report.location(path));
  } else if (decoded.encoding !== "UTF-8") {
    yield* report.message("RSC-028", Report.location(path), decoded.encoding);
  }
  if (decoded.text === undefined) {
    const error = decoded.error;
    yield* report.message(
      "RSC-016",
      Report.location(path, error?.line ?? 1, error?.column ?? 1),
      error?.message ?? "",
    );
    return Option.none<Xml.XmlDocument>();
  }
  const parsed = Xml.parse(decoded.text, {
    externalEntities: (doctype) => entitiesOf(doctype, version),
  });
  if (Result.isFailure(parsed)) {
    const { message, line, column, version: failedVersion } = parsed.failure;
    if (checksVersion && failedVersion !== undefined && failedVersion !== "1.0") {
      yield* report.message("HTM-001", Report.location(path), failedVersion);
    }
    yield* report.message("RSC-016", Report.location(path, line, column), message);
    return Option.none<Xml.XmlDocument>();
  }
  // Upstream's XMLHandler checks the XML version of every document it parses.
  const xmlVersion = parsed.success.version;
  if (checksVersion && xmlVersion !== undefined && xmlVersion !== "1.0") {
    yield* report.message("HTM-001", Report.location(path), xmlVersion);
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
