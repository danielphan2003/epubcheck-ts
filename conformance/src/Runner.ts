import * as Effect from "effect/Effect";

import { cliSteps } from "./CliSteps.ts";
import type { Scenario } from "./Features.ts";
import { reportSteps } from "./ReportSteps.ts";
import { makeWorld, steps as coreSteps, type Check, type StepDefinition } from "./Steps.ts";

const steps = [...coreSteps, ...cliSteps, ...reportSteps];

export type ScenarioStatus = "passed" | "failed" | "undefined";

export interface ScenarioResult {
  readonly scenario: Scenario;
  readonly status: ScenarioStatus;
  readonly detail?: string | undefined;
  readonly checks: ReadonlyArray<Check>;
}

const matchStep = (text: string) => {
  const matches: Array<{
    readonly definition: StepDefinition;
    readonly args: ReadonlyArray<unknown>;
  }> = [];
  for (const definition of steps) {
    const args = definition.expression.match(text);
    if (args !== null) matches.push({ definition, args: args.map((arg) => arg.getValue(null)) });
  }
  return matches;
};

// One fiber per scenario; scenarios share nothing, so they can run concurrently. The scope holds
// a scenario's scratch files.
export const runScenario = Effect.fn("Runner.runScenario")(function* (
  scenario: Scenario,
  resourcesDir: string,
) {
  const world = makeWorld(resourcesDir);
  for (const step of scenario.steps) {
    const matches = matchStep(step.text);
    const [match] = matches;
    if (match === undefined) {
      return {
        scenario,
        status: "undefined",
        detail: `Undefined step: ${step.text}`,
        checks: world.checks,
      } satisfies ScenarioResult;
    }
    if (matches.length > 1) {
      return {
        scenario,
        status: "failed",
        detail: `Ambiguous step: ${step.text}`,
        checks: world.checks,
      } satisfies ScenarioResult;
    }
    const failure = yield* match.definition.run(world, match.args, step).pipe(
      Effect.as(undefined),
      Effect.catchTags({
        StepFailed: (error) => Effect.succeed(`${step.text}: ${error.reason}`),
      }),
    );
    if (failure !== undefined) {
      return {
        scenario,
        status: "failed",
        detail: failure,
        checks: world.checks,
      } satisfies ScenarioResult;
    }
  }
  return { scenario, status: "passed", checks: world.checks } satisfies ScenarioResult;
}, Effect.scoped);

export const runScenarios = Effect.fn("Runner.runScenarios")(function* (
  scenarios: ReadonlyArray<Scenario>,
  resourcesDir: string,
) {
  return yield* Effect.forEach(scenarios, (scenario) => runScenario(scenario, resourcesDir), {
    concurrency: 8,
  });
});
