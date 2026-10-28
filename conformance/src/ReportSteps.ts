import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { JsonReport, XmlReport } from "epubcheck-ts";
import fontoxpath from "fontoxpath";
import { JSONPath } from "jsonpath-plus";
import * as slimdom from "slimdom";

import { type World, define, fail, noop, type StepDefinition } from "./Steps.ts";

// Upstream's JSON and XML report steps: render the last check's report, then query it with
// JSONPath (Jayway semantics) or XPath.

const DEFAULT_MAX = 25;
const JsonText = Schema.fromJsonString(Schema.Unknown);

const options = (world: World) => ({
  path: world.lastResult?.path ?? "",
  maxOfEachMessage: world.maxOfEachMessage ?? DEFAULT_MAX,
  checkedAt: 0,
  elapsedTime: 0,
});

const jsonReport = Effect.fn("ReportSteps.jsonReport")(function* (world: World) {
  if (world.json !== undefined) return world.json;
  const result = world.lastResult;
  if (result === undefined) return yield* fail("No EPUB was checked");
  const json = yield* Schema.decodeEffect(JsonText)(JsonReport.render(result, options(world))).pipe(
    Effect.catchTags({ SchemaError: (error) => fail(`Invalid JSON report: ${error.message}`) }),
  );
  world.json = json;
  return json;
});

const isJsonContainer = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

// Jayway returns a definite path's value itself and an indefinite path's matches as a list.
const query = Effect.fn("ReportSteps.query")(function* (world: World, path: string) {
  const json = yield* jsonReport(world);
  if (!isJsonContainer(json)) return yield* fail("The JSON report is not an object");
  const found: unknown = JSONPath({ path, json, wrap: true });
  const matches: ReadonlyArray<unknown> = Array.isArray(found) ? found : [];
  const definite = !/\.\.|\[\?|\*|,/.test(path);
  return definite ? matches[0] : matches;
});

const show = (value: unknown) => Schema.encodeUnknownSync(JsonText)(value);

const jsonAssertion = <S extends Schema.Decoder<unknown>>(
  text: string,
  expected: S,
  holds: (actual: unknown, expected: S["Type"]) => boolean,
) =>
  define(text, Schema.Tuple([Schema.String, expected]), (world, [path, value]) =>
    query(world, path).pipe(
      Effect.flatMap((actual) =>
        holds(actual, value) ? noop : fail(`Unexpected JSON at ${path}: ${show(actual)}`),
      ),
    ),
  );

const xmlDocument = Effect.fn("ReportSteps.xmlDocument")(function* (world: World) {
  const result = world.lastResult;
  if (result === undefined) return yield* fail("No EPUB was checked");
  const xml = world.xml ?? XmlReport.renderJhove(result, { ...options(world), uri: result.path });
  world.xml = xml;
  return yield* Effect.try({
    try: () => slimdom.parseXmlDocument(xml),
    catch: (error) => `The XML report is not well-formed: ${String(error)}`,
  }).pipe(Effect.catch((reason) => fail(reason)));
});

const xpath = Effect.fn("ReportSteps.xpath")(function* <A>(
  world: World,
  expression: string,
  evaluate: (document: slimdom.Document, options: fontoxpath.Options) => A,
) {
  const document = yield* xmlDocument(world);
  const namespace = world.defaultNamespace;
  return yield* Effect.try({
    try: () =>
      evaluate(document, {
        namespaceResolver: (prefix: string) => (prefix === "" ? (namespace ?? null) : null),
      }),
    catch: (error) => `XPath ${expression} failed: ${String(error)}`,
  }).pipe(Effect.catch((reason) => fail(reason)));
});

export const reportSteps: ReadonlyArray<StepDefinition> = [
  define("the JSON report is valid", Schema.Tuple([]), (world) =>
    jsonReport(world).pipe(Effect.asVoid),
  ),
  jsonAssertion(
    "JSON at {string} contains {int} items",
    Schema.Number,
    (actual, count) => Array.isArray(actual) && actual.length === count,
  ),
  jsonAssertion("JSON at {string} is {int}", Schema.Number, (actual, number) => actual === number),
  jsonAssertion("JSON at {string} is {string}", Schema.String, (actual, text) => actual === text),
  jsonAssertion("JSON at {string} is {bool}", Schema.Boolean, (actual, bool) => actual === bool),
  jsonAssertion(
    "JSON at {string} are all {string}",
    Schema.String,
    (actual, text) =>
      Array.isArray(actual) && actual.length > 0 && actual.every((value) => value === text),
  ),
  jsonAssertion(
    "JSON at {string} are all {bool}",
    Schema.Boolean,
    (actual, bool) =>
      Array.isArray(actual) && actual.length > 0 && actual.every((value) => value === bool),
  ),
  define("JSON at {string} is empty", Schema.Tuple([Schema.String]), (world, [path]) =>
    query(world, path).pipe(
      Effect.flatMap((actual) =>
        Array.isArray(actual) && actual.length === 0
          ? noop
          : fail(`Expected nothing at ${path} but got ${show(actual)}`),
      ),
    ),
  ),
  define("JSON at {string} has no null values", Schema.Tuple([Schema.String]), (world, [path]) =>
    query(world, path).pipe(
      Effect.flatMap((actual) =>
        (Array.isArray(actual) ? actual : [actual]).some((value) => value === null)
          ? fail(`Null values at ${path}: ${show(actual)}`)
          : noop,
      ),
    ),
  ),
  define("JSON at {string} is:", Schema.Tuple([Schema.String]), (world, [path], step) => {
    const rows = step.argument?.dataTable?.rows.map((row) => row.cells[0]?.value ?? "") ?? [];
    return query(world, path).pipe(
      Effect.flatMap((actual) =>
        Array.isArray(actual) &&
        actual.length === rows.length &&
        actual.every((value, index) => value === rows[index])
          ? noop
          : fail(`Expected ${show(rows)} at ${path} but got ${show(actual)}`),
      ),
    );
  }),
  define("the default namespace is {string}", Schema.Tuple([Schema.String]), (world, [namespace]) =>
    Effect.sync(() => {
      world.defaultNamespace = namespace;
    }),
  ),
  define("the XML report is well-formed", Schema.Tuple([]), (world) =>
    xmlDocument(world).pipe(Effect.asVoid),
  ),
  define("XPath {string} exists", Schema.Tuple([Schema.String]), (world, [expression]) =>
    xpath(world, expression, (document, options) =>
      fontoxpath.evaluateXPathToBoolean(`exists(${expression})`, document, null, null, options),
    ).pipe(Effect.flatMap((exists) => (exists ? noop : fail(`Nothing matches ${expression}`)))),
  ),
  define(
    "XPath {string} is {int}",
    Schema.Tuple([Schema.String, Schema.Number]),
    (world, [expression, number]) =>
      xpath(world, expression, (document, options) =>
        fontoxpath.evaluateXPathToNumber(expression, document, null, null, options),
      ).pipe(
        Effect.flatMap((actual) =>
          actual === number
            ? noop
            : fail(`Expected ${expression} to be ${number} but got ${actual}`),
        ),
      ),
  ),
];
