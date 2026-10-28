import { AstBuilder, compile, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { IdGenerator, type GherkinDocument, type PickleStep } from "@cucumber/messages";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class FeatureParseError extends Schema.TaggedError<FeatureParseError>()(
  "FeatureParseError",
  { feature: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Cannot parse feature file ${this.feature}.`;
  }
}

export interface Scenario {
  // `<feature path>:<line>`; the line is the scenario's, or the example row's for outlines.
  readonly id: string;
  readonly feature: string;
  readonly area: string;
  readonly name: string;
  readonly steps: ReadonlyArray<PickleStep>;
}

const astNodeLines = (document: GherkinDocument) => {
  const lines = new Map<string, number>();
  const children = document.feature?.children ?? [];
  const scenarios = children.flatMap((child) => [
    ...(child.scenario === undefined ? [] : [child.scenario]),
    ...(child.rule?.children.flatMap((ruleChild) =>
      ruleChild.scenario === undefined ? [] : [ruleChild.scenario],
    ) ?? []),
  ]);
  for (const scenario of scenarios) {
    lines.set(scenario.id, scenario.location.line);
    for (const examples of scenario.examples) {
      for (const row of examples.tableBody) lines.set(row.id, row.location.line);
    }
  }
  return lines;
};

// Feature paths are relative to the upstream `src/test/resources` root.
export const parseFeature = (feature: string, source: string) =>
  Effect.try({
    try: () => {
      const newId = IdGenerator.incrementing();
      const parser = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher());
      const document = parser.parse(source);
      const lines = astNodeLines(document);
      const area = feature.includes("/") ? feature.slice(0, feature.lastIndexOf("/")) : ".";
      return compile(document, feature, newId).map((pickle): Scenario => {
        const line = lines.get(pickle.astNodeIds.at(-1) ?? "") ?? 0;
        return { id: `${feature}:${line}`, feature, area, name: pickle.name, steps: pickle.steps };
      });
    },
    catch: (cause) => new FeatureParseError({ feature, cause }),
  });

export const loadScenarios = Effect.fn("Features.loadScenarios")(function* (resourcesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = (yield* fs.readDirectory(resourcesDir, { recursive: true }))
    .filter((file) => file.endsWith(".feature"))
    .map((file) => file.split(path.sep).join("/"))
    .sort();
  const scenarios: Array<Scenario> = [];
  for (const feature of files) {
    const source = yield* fs.readFileString(path.join(resourcesDir, feature));
    scenarios.push(...(yield* parseFeature(feature, source)));
  }
  return scenarios;
});
