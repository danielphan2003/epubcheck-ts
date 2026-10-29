import * as Result from "effect/Result";

import type * as Xml from "../xml/Xml.ts";
import type { Datatype } from "./Datatypes.ts";
import * as Grammar from "./Grammar.ts";
import * as Rng from "./Rng.ts";
import * as Schematron from "./Schematron.ts";
import { sources } from "./sources.generated.ts";
import { SchemaValidator, type SchemaError } from "./Validator.ts";

// Upstream's schemas, keyed by their path under `schema/`. Each compiles once, on first use.

const read = (path: string) => sources[path];

// HTML datatypes from validator.nu are not implemented yet: accept any value rather than
// report errors upstream would not.
const lenient = (name: string): Datatype => ({
  key: `whattf:${name}`,
  contextDependent: false,
  normalize: (value) => value,
  validate: () => undefined,
});

const relaxng = new Map<string, SchemaValidator | undefined>();
const schematron = new Map<string, Schematron.SchematronSchema | undefined>();

const relaxngValidator = (path: string) => {
  if (relaxng.has(path)) return relaxng.get(path);
  const compiled = Grammar.compile({ read }, path, { whattf: lenient }, Rng.parse);
  const validator = Result.isSuccess(compiled) ? new SchemaValidator(compiled.success) : undefined;
  relaxng.set(path, validator);
  return validator;
};

// A schema that does not compile validates nothing, so tests check every one the checkers use.
export const compileErrors = (path: string) => {
  const compiled = Grammar.compile({ read }, path, { whattf: lenient }, Rng.parse);
  return Result.isSuccess(compiled) ? [] : compiled.failure;
};

const schematronSchema = (path: string) => {
  if (schematron.has(path)) return schematron.get(path);
  const source = read(path);
  const parsed = source === undefined ? undefined : Schematron.parse(source, path, read);
  const schema = parsed !== undefined && Result.isSuccess(parsed) ? parsed.success : undefined;
  schematron.set(path, schema);
  return schema;
};

// Validates against each schema in order: RELAX NG errors come before Schematron ones, as in
// upstream, where Schematron reports at the end of the document.
export const validate = (
  document: Xml.XmlDocument,
  schemas: ReadonlyArray<string>,
  baseUrl: string,
) => {
  const errors: Array<SchemaError> = [];
  for (const path of schemas) {
    if (path.endsWith(".sch")) {
      const schema = schematronSchema(path);
      if (schema !== undefined) errors.push(...Schematron.validate(schema, document, baseUrl));
    } else {
      const validator = relaxngValidator(path);
      if (validator !== undefined) errors.push(...validator.validate(document));
    }
  }
  return errors;
};

export const PACKAGE_20 = ["20/rng/opf.rng", "20/sch/opf.sch"];
export const PACKAGE_30 = [
  "30/package-30.rnc",
  "30/package-30.sch",
  "30/collection-do-30.sch",
  "30/dict/dict-collection.sch",
  "30/idx/idx-collection.sch",
  "30/collection-manifest-30.sch",
  "30/previews/preview-collection.sch",
];
export const CONTAINER_20 = ["20/rng/container.rng"];
export const CONTAINER_30 = ["30/ocf-container-30.rnc", "30/multiple-renditions/container.sch"];
export const ENCRYPTION_20 = ["20/rng/encryption.rng"];
export const ENCRYPTION_30 = ["30/ocf-encryption-30.rnc", "30/ocf-encryption-30.sch"];
export const SIGNATURES_20 = ["20/rng/signatures.rng"];
export const SIGNATURES_30 = ["30/ocf-signatures-30.rnc"];
export const METADATA_30 = ["30/ocf-metadata-30.rnc", "30/ocf-metadata-30.sch"];
export const RENDITION_MAPPING = [
  "30/multiple-renditions/mapping.rnc",
  "30/multiple-renditions/mapping.sch",
];
