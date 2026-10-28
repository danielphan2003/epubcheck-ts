import * as Schema from "effect/Schema";

import type { Scenario } from "./Features.ts";
import type { ScenarioResult } from "./Runner.ts";

const Tally = Schema.Struct({ passed: Schema.Number, total: Schema.Number });
export interface Tally extends Schema.Schema.Type<typeof Tally> {}

export const Score = Schema.Struct({
  upstream: Schema.String,
  passed: Schema.Number,
  total: Schema.Number,
  // Scenarios that assert at least one reported message. A checker that reports nothing passes
  // every other scenario, so this subset is the honest measure of detection.
  expectsMessages: Tally,
  areas: Schema.Record(Schema.String, Tally),
});
export interface Score extends Schema.Schema.Type<typeof Score> {}

export const decodeScore = Schema.decodeUnknownEffect(Schema.fromJsonString(Score));

const positiveAssertion =
  /^(?:the )?(?:following )?(?:fatal error|error|warning|usage|info)s?\b.*\breported\b/i;

export const expectsMessages = (scenario: Scenario) =>
  scenario.steps.some((step) => positiveAssertion.test(step.text));

const tally = (results: ReadonlyArray<ScenarioResult>): Tally => ({
  passed: results.filter((result) => result.status === "passed").length,
  total: results.length,
});

export const summarize = (results: ReadonlyArray<ScenarioResult>, upstream: string): Score => {
  const byArea = new Map<string, Array<ScenarioResult>>();
  for (const result of results) {
    const area = byArea.get(result.scenario.area) ?? [];
    area.push(result);
    byArea.set(result.scenario.area, area);
  }
  const areas: Record<string, Tally> = {};
  for (const area of [...byArea.keys()].sort()) areas[area] = tally(byArea.get(area) ?? []);
  return {
    upstream,
    ...tally(results),
    expectsMessages: tally(results.filter((result) => expectsMessages(result.scenario))),
    areas,
  };
};

export const renderScore = (score: Score) => `${JSON.stringify(score, null, 2)}\n`;

export const renderPassing = (results: ReadonlyArray<ScenarioResult>) =>
  results
    .filter((result) => result.status === "passed")
    .map((result) => `${result.scenario.id} ${result.scenario.name.trim()}`)
    .sort()
    .join("\n")
    .concat("\n");

const percent = ({ passed, total }: Tally) =>
  total === 0 ? "n/a" : `${((passed / total) * 100).toFixed(1)}%`;

// Pre-aligned the way oxfmt formats Markdown tables, so `pnpm fmt` leaves the README untouched.
const alignTable = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  rightAligned: ReadonlyArray<boolean>,
) => {
  const widths =
    rows[0]?.map((_, column) => Math.max(3, ...rows.map((row) => (row[column] ?? "").length))) ??
    [];
  const line = (cells: ReadonlyArray<string>) =>
    `| ${cells
      .map((cell, column) =>
        rightAligned[column] === true
          ? cell.padStart(widths[column] ?? 0)
          : cell.padEnd(widths[column] ?? 0),
      )
      .join(" | ")} |`;
  const [header, ...body] = rows;
  const separator = widths.map((width, column) =>
    rightAligned[column] === true ? `${"-".repeat(width - 1)}:` : "-".repeat(width),
  );
  return [line(header ?? []), line(separator), ...body.map(line)];
};

export const renderTable = (score: Score) =>
  [
    `Upstream suite: EPUBCheck ${score.upstream}. Passing **${score.passed} / ${score.total}** scenarios (${percent(score)}); scenarios that expect reported messages: **${score.expectsMessages.passed} / ${score.expectsMessages.total}** (${percent(score.expectsMessages)}).`,
    "",
    ...alignTable(
      [
        ["Area", "Passing", "Total", "%"],
        ...Object.entries(score.areas).map(([area, value]) => [
          `\`${area}\``,
          String(value.passed),
          String(value.total),
          percent(value),
        ]),
      ],
      [false, true, true, true],
    ),
  ].join("\n");

export const README_START = "<!-- conformance:start -->";
export const README_END = "<!-- conformance:end -->";

export const injectTable = (readme: string, score: Score) => {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start < 0 || end < start) return readme;
  return `${readme.slice(0, start + README_START.length)}\n\n${renderTable(score)}\n\n${readme.slice(end)}`;
};

export interface Comparison {
  readonly regressions: ReadonlyArray<string>;
  readonly improvements: ReadonlyArray<string>;
}

const scenarioId = (line: string) => {
  const space = line.indexOf(" ");
  return space < 0 ? line : line.slice(0, space);
};

// Compares passing-scenario lists by scenario id (the text before the first space).
export const comparePassing = (baseline: string, current: string): Comparison => {
  const ids = (text: string) =>
    new Map(
      text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => [scenarioId(line), line] as const),
    );
  const before = ids(baseline);
  const after = ids(current);
  return {
    regressions: [...before].filter(([id]) => !after.has(id)).map(([, line]) => line),
    improvements: [...after].filter(([id]) => !before.has(id)).map(([, line]) => line),
  };
};
