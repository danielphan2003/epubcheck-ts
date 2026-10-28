import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { EpubCheck, Report, type MessageCatalog } from "epubcheck-ts";

import * as Features from "./Features.ts";
import * as Runner from "./Runner.ts";

const message = (
  id: MessageCatalog.MessageId,
  severity: MessageCatalog.Severity,
): Report.Message => ({
  id,
  severity,
  message: `${id} text`,
  suggestion: "",
  location: Report.location("minimal.epub", 3, 7),
});

// The fake checker answers every check with fixed messages, so the test exercises only the harness.
const fakeChecker = (messages: ReadonlyArray<Report.Message>) =>
  Layer.succeed(
    EpubCheck.EpubCheck,
    EpubCheck.EpubCheck.of({
      check: (request) => Effect.succeed({ path: request.path, mode: "epub", messages }),
    }),
  );

const scenario = (steps: string) =>
  `Feature: harness\n  Background:\n    Given EPUB test files located at '/epub3/00-minimal/files/'\n\n  Scenario: case\n    When checking EPUB 'minimal.epub'\n${steps}\n`;

const runOne = (source: string, messages: ReadonlyArray<Report.Message>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const resources = path.resolve(
      import.meta.dirname,
      "../../vendor/epubcheck/src/test/resources",
    );
    const [parsed] = yield* Features.parseFeature("harness/test.feature", source);
    if (parsed === undefined) return yield* Effect.die("feature has no scenario");
    return yield* Runner.runScenario(parsed, resources).pipe(Effect.provide(fakeChecker(messages)));
  }).pipe(Effect.provide(NodeServices.layer));

describe("Runner.runScenario", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly steps: string;
    readonly messages: ReadonlyArray<Report.Message>;
    readonly status: Runner.ScenarioStatus;
  }> = [
    {
      name: "consumes the asserted error before checking for others",
      steps: "    Then error OPF-001 is reported\n    And no other errors or warnings are reported",
      messages: [message("OPF-001", "ERROR")],
      status: "passed",
    },
    {
      name: "fails on an unexpected warning",
      steps: "    Then error OPF-001 is reported\n    And no other errors or warnings are reported",
      messages: [message("OPF-001", "ERROR"), message("PKG-010", "WARNING")],
      status: "failed",
    },
    {
      name: "ignores leftover usages when only errors and warnings are asserted",
      steps: "    Then no errors or warnings are reported",
      messages: [message("PKG-012", "USAGE")],
      status: "passed",
    },
    {
      name: "fails when the severity differs",
      steps: "    Then warning OPF-001 is reported",
      messages: [message("OPF-001", "ERROR")],
      status: "failed",
    },
    {
      name: "counts repeated messages",
      steps:
        "    Then error RSC-005 is reported 2 times\n    And no other errors or warnings are reported",
      messages: [message("RSC-005", "ERROR"), message("RSC-005", "ERROR")],
      status: "passed",
    },
    {
      name: "checks the last asserted message's text and location",
      steps:
        "    Then error OPF-001 is reported (with a reason)\n    And the message contains 'OPF-001 text'\n    And the message has line and column info",
      messages: [message("OPF-001", "ERROR")],
      status: "passed",
    },
    {
      name: "matches a following-messages table in order",
      steps:
        "    Then the following errors are reported\n      | OPF-001 | text |\n      | RSC-005 |      |",
      messages: [message("OPF-001", "ERROR"), message("RSC-005", "ERROR")],
      status: "passed",
    },
    {
      name: "reports steps it does not know as undefined",
      steps: "    Then the moon is reported",
      messages: [],
      status: "undefined",
    },
  ];

  it.effect.each(cases)("$name", (testCase) =>
    Effect.gen(function* () {
      const result = yield* runOne(scenario(testCase.steps), testCase.messages);
      expect(result.status, result.detail).toBe(testCase.status);
    }),
  );
});

describe("Features.parseFeature", () => {
  it.effect("gives each scenario outline example row its own id", () =>
    Effect.gen(function* () {
      const scenarios = yield* Features.parseFeature(
        "area/outline.feature",
        "Feature: f\n  Scenario Outline: o <n>\n    When checking EPUB '<n>'\n\n    Examples:\n      | n |\n      | a |\n      | b |\n",
      );
      expect(scenarios.map((entry) => [entry.id, entry.area, entry.name])).toEqual([
        ["area/outline.feature:7", "area", "o a"],
        ["area/outline.feature:8", "area", "o b"],
      ]);
    }),
  );
});
